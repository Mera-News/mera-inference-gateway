import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { searchUnavailable } from '../search-unavailable';

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

  async search(query: string): Promise<WebSearchResultItem[]> {
    const trimmed = (query ?? '').trim();

    if (trimmed.length < MIN_QUERY_LENGTH) {
      throw new BadRequestException(`Query must be at least ${MIN_QUERY_LENGTH} characters`);
    }
    if (trimmed.length > MAX_QUERY_LENGTH) {
      throw new BadRequestException(`Query must be at most ${MAX_QUERY_LENGTH} characters`);
    }

    // Kill switch AFTER validation but BEFORE the key is used or any request is
    // made. 503, NOT `[]`: "the operator switched search off" and "Brave found
    // nothing" must never be the same response. Degrading quietly was the
    // original intent and it was the wrong trade — a client cannot render an
    // honest "I could not search" from a success it was handed.
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
