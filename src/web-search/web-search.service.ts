import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SEARCH_UNAVAILABLE_CODE,
  searchUnavailable,
  type SearchUnavailableReason,
} from '../search-unavailable';

/** DI token for the `fetch` implementation, so specs bind a stub instead of
 *  reaching the network. Bound to the global `fetch` in `WebSearchModule`. */
export const WEB_SEARCH_FETCH = 'WEB_SEARCH_FETCH';

export type FetchFn = typeof globalThis.fetch;

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

/** Shorter than this is noise, not a query, and Brave charges for it anyway. */
export const MIN_QUERY_LENGTH = 2;

/** Longer than this is a paste accident or an abuse attempt. */
export const MAX_QUERY_LENGTH = 200;

/** Hard result cap. Not caller-settable — there is no `limit` in the request. */
export const MAX_WEB_SEARCH_RESULTS = 10;

/**
 * How many queries one multi-query request may carry.
 *
 * THIS IS THE SPEND CEILING PER CHAT TURN, and it is the only thing standing
 * between a model that likes searching and a Brave bill. Batching removes
 * waiting, never cost: N queries are still N billed Brave requests, issued
 * concurrently instead of one after another.
 */
export const MAX_BATCH_QUERIES = 4;

/**
 * One entry of a multi-query response, and it is a UNION on purpose.
 *
 * `results` present  →  we searched THIS query. `[]` means the index had
 *                       nothing, exactly as a 200 + `[]` does on the single
 *                       route.
 * `code` present     →  we did NOT search this query. Never render it as
 *                       "found nothing" — see `../search-unavailable.ts`.
 *
 * The two never appear together. A caller that reads `results` without first
 * checking `code` gets `undefined`, not a misleading empty array: that is the
 * shape doing the work the status code does on the single-query route.
 */
export type WebSearchBatchEntry =
  | { query: string; results: WebSearchResultItem[] }
  | { query: string; code: typeof SEARCH_UNAVAILABLE_CODE; reason: SearchUnavailableReason };

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

/** Brave's own per-request ceiling. */
const BRAVE_MAX_COUNT = 20;

/** Upstream deadline, enforced with an AbortController exactly like
 *  `ChatService.proxyChat`. A search that has not answered in 8s is useless to
 *  a chat turn that is already waiting on it. */
const REQUEST_TIMEOUT_MS = 8_000;

interface BraveWebResult {
  title?: unknown;
  url?: unknown;
  description?: unknown;
}

/**
 * Pulls the `reason` back out of a 503 built by `searchUnavailable`.
 *
 * Needed because `Promise.allSettled` hands back the thrown value and the batch
 * path has to decide, per rejection, whether it describes the gateway (fail the
 * whole request) or just this one query (report it as an entry). Anything that
 * is not one of our own 503s — a timeout, an unclassified upstream status — has
 * no reason of its own and returns `undefined`.
 */
function reasonOf(error: unknown): SearchUnavailableReason | undefined {
  if (!(error instanceof ServiceUnavailableException)) return undefined;
  const body = error.getResponse();
  const reason =
    typeof body === 'object' && body !== null ? (body as { reason?: unknown }).reason : undefined;
  return typeof reason === 'string' ? (reason as SearchUnavailableReason) : undefined;
}

/**
 * Authenticated proxy in front of Brave Search.
 *
 * WHY A PROXY AT ALL: `BRAVE_SEARCH_API_KEY` must never reach a client. A key
 * shipped in an app binary is a public key, and Brave bills per request.
 *
 * THE API KEY NEVER LEAVES THIS FILE. It is read from `BRAVE_SEARCH_API_KEY`
 * via ConfigService and put into the `X-Subscription-Token` request header; it
 * is never returned to the caller and never logged, not even truncated.
 *
 * THE QUERY IS NEVER LOGGED EITHER. This route — unlike the inference path —
 * necessarily receives plaintext search terms, because a third-party search API
 * has to be queried with them. Logging them would turn a pass-through into a
 * record. Log lengths and statuses, never the text, and never alongside a user
 * id: the gateway keeps no association between a user and a search.
 *
 * DISABLED IS NOT EMPTY. See `../search-unavailable.ts` for the full argument.
 * This service USED to return `[]` when its spend gate was off, which a caller
 * cannot tell apart from a genuine zero-hit search — so a fact-checker built on
 * it would report a fabricated all-clear. Every state in which we did not reach
 * Brave now throws a 503 carrying `code: 'search-unavailable'`. A 200 with `[]`
 * means one thing only: we asked Brave and Brave had nothing.
 */
@Injectable()
export class WebSearchService {
  private readonly logger = new Logger(WebSearchService.name);
  private readonly enabled: boolean;
  private readonly apiKey: string;

  constructor(
    private readonly configService: ConfigService,
    @Inject(WEB_SEARCH_FETCH) private readonly fetchFn: FetchFn,
  ) {
    // SPEND GATE, DEFAULT OFF. Brave bills per request, so merging or
    // deploying this code must not begin spending on its own.
    this.enabled =
      String(
        this.configService.get<string | boolean>('BRAVE_SEARCH_ENABLED', false),
      ).toLowerCase() === 'true';
    // Read with an empty default rather than throwing at construction (which
    // is what ChatService does for NEAR_AI_API_KEY): web search is optional and
    // off by default, so a missing key must not stop the gateway from booting.
    this.apiKey = this.configService.get<string>('BRAVE_SEARCH_API_KEY', '');
  }

  /**
   * One query. Unchanged contract: resolves to results (possibly `[]`, meaning
   * we searched and Brave had nothing), or throws — 400 on length, 503 on any
   * state where we did not search, and a plain Error the controller turns into
   * a 502 for everything else.
   */
  async search(query: string): Promise<WebSearchResultItem[]> {
    const trimmed = this.validateQuery(query);
    this.assertAvailable();
    return this.braveSearch(trimmed);
  }

  /**
   * Several queries in ONE request, fanned out concurrently.
   *
   * WHY THIS EXISTS ON THE SERVER. The app funnels every gateway call through a
   * shared FIFO that grants one caller every 3s, so N searches issued from the
   * device are N × 3s of waiting no matter how concurrently the client writes
   * them. Moving the fan-out here costs one grant and one round trip for the
   * whole set. It does NOT reduce spend: N queries are still N billed Brave
   * requests. `MAX_BATCH_QUERIES` is the ceiling.
   *
   * WHAT FAILS THE WHOLE REQUEST vs WHAT FAILS ONE ENTRY, and the line between
   * them is "does this tell us anything about the other queries":
   *   - length, gate off, key absent, key REJECTED → the whole request throws,
   *     because every query in it was doomed for the same reason.
   *   - a timeout, a 429, an unclassified upstream status → that ENTRY carries
   *     `code`, and the queries that did succeed are still returned.
   * An entry with `code` is "we did not search this", never "nothing found".
   */
  async searchMany(queries: string[]): Promise<WebSearchBatchEntry[]> {
    if (!Array.isArray(queries) || queries.length === 0) {
      throw new BadRequestException('queries must be a non-empty array');
    }
    if (queries.length > MAX_BATCH_QUERIES) {
      throw new BadRequestException(`queries must contain at most ${MAX_BATCH_QUERIES} items`);
    }

    // Validate EVERY query before searching ANY of them. Half a batch billed
    // and then rejected is the worst of both outcomes.
    const trimmed = queries.map((q) => this.validateQuery(q));
    this.assertAvailable();

    const settled = await Promise.allSettled(trimmed.map((q) => this.braveSearch(q)));

    // A rejected key is a property of the gateway, not of one query, so it
    // fails the request rather than being reported four times over.
    for (const outcome of settled) {
      if (outcome.status === 'rejected' && reasonOf(outcome.reason) === 'upstream-rejected-key') {
        throw outcome.reason;
      }
    }

    return settled.map((outcome, i) => {
      const query = trimmed[i];
      if (outcome.status === 'fulfilled') return { query, results: outcome.value };
      const reason = reasonOf(outcome.reason) ?? 'upstream-failed';
      this.logger.warn(`batch entry ${i} unavailable (${reason})`);
      return { query, code: SEARCH_UNAVAILABLE_CODE, reason };
    });
  }

  /** Trim and bound-check. Throws 400; returns the trimmed query. */
  private validateQuery(query: string): string {
    const trimmed = (query ?? '').trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      throw new BadRequestException(`Query must be at least ${MIN_QUERY_LENGTH} characters`);
    }
    if (trimmed.length > MAX_QUERY_LENGTH) {
      throw new BadRequestException(`Query must be at most ${MAX_QUERY_LENGTH} characters`);
    }
    return trimmed;
  }

  /**
   * Kill switch AFTER validation but BEFORE the key is used or any request is
   * made. 503, NOT `[]`: "the operator switched search off" and "Brave found
   * nothing" must never be the same response. Degrading quietly was the
   * original intent and it was the wrong trade — a client cannot render an
   * honest "I could not search" from a success it was handed.
   */
  private assertAvailable(): void {
    if (!this.enabled) {
      this.logger.log('web search disabled (BRAVE_SEARCH_ENABLED is not true)');
      throw searchUnavailable('disabled', 'Web search is disabled on this gateway');
    }

    // Same envelope as the gate above, for the same reason: a deploy that
    // flipped the flag without provisioning the key must be loud, and it must
    // not be mistakable for a search that came back empty.
    if (!this.apiKey) {
      this.logger.error('BRAVE_SEARCH_ENABLED is true but BRAVE_SEARCH_API_KEY is not configured');
      throw searchUnavailable('not-configured', 'Web search is not configured');
    }
  }

  /** One Brave round trip. Assumes validated input and an available gate. */
  private async braveSearch(trimmed: string): Promise<WebSearchResultItem[]> {
    const count = Math.max(1, Math.min(BRAVE_MAX_COUNT, MAX_WEB_SEARCH_RESULTS));
    const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(trimmed)}&count=${count}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const startedAt = Date.now();

    try {
      const response = await this.fetchFn(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': this.apiKey,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        // Status only — the response body of an auth failure can echo request
        // headers back, and those contain the key.

        // A rejected key is a CONFIGURATION failure wearing an upstream status,
        // so it gets the same 503 as an absent one rather than a 502. Anything
        // else and a rotated-but-not-updated key would look like a flaky
        // provider forever.
        if (response.status === 401 || response.status === 403) {
          this.logger.error(`Brave rejected our credentials (status ${response.status})`);
          throw searchUnavailable('upstream-rejected-key', 'Web search is not configured');
        }
        // 429 is the one the fact-checker most needs to see as "blocked".
        // Throttled means WE NEVER LOOKED, and the caller must be able to tell
        // that apart from "nobody has published on this".
        if (response.status === 429) {
          this.logger.warn('Brave rate-limited this gateway (429)');
          throw searchUnavailable('upstream-rate-limited', 'Web search is rate-limited upstream');
        }
        throw new Error(`Brave search failed with status ${response.status}`);
      }

      const body = (await response.json()) as {
        web?: { results?: BraveWebResult[] };
      };
      const results = body?.web?.results;
      // `[]` HERE IS HONEST AND STAYS. Brave omits the `web` block entirely on a
      // query with no hits, so this is the genuine zero-result path — we asked
      // and the index had nothing. It is the one empty array this service is
      // still allowed to return, and the 200 status is what distinguishes it
      // from every unavailable state above.
      if (!Array.isArray(results)) {
        this.logger.warn('Brave search returned no `web.results` array');
        return [];
      }

      const mapped = results
        .filter((r) => typeof r?.url === 'string' && r.url.length > 0)
        .slice(0, MAX_WEB_SEARCH_RESULTS)
        .map((r) => ({
          title: typeof r.title === 'string' ? r.title : '',
          url: r.url as string,
          snippet: typeof r.description === 'string' ? r.description : '',
        }));

      this.logger.debug(
        `brave responded status=${response.status} elapsedMs=${Date.now() - startedAt} ` +
          `queryLength=${trimmed.length} results=${mapped.length}`,
      );
      return mapped;
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      if ((error as { name?: string })?.name === 'AbortError') {
        throw new Error(
          `Brave search timed out after ${elapsedMs}ms (limit=${REQUEST_TIMEOUT_MS}ms)`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
