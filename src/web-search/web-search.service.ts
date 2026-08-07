import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
    // made. Returns [] rather than throwing — a spend gate must degrade quietly
    // instead of rendering the client's search UI broken.
    if (!this.enabled) {
      this.logger.log('web search disabled (BRAVE_SEARCH_ENABLED is not true)');
      return [];
    }

    if (!this.apiKey) {
      throw new Error('BRAVE_SEARCH_API_KEY is not configured; refusing to call Brave');
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
        throw new Error(`Brave search failed with status ${response.status}`);
      }

      const body = (await response.json()) as {
        web?: { results?: BraveWebResult[] };
      };
      const results = body?.web?.results;
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
