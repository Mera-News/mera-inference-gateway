import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { searchUnavailable } from '../search-unavailable';

/** DI token for the `fetch` implementation, so specs bind a stub instead of
 *  reaching the network. Bound to the global `fetch` in
 *  `FactCheckClaimsModule` — the same shape `WEB_SEARCH_FETCH` uses. */
export const FACT_CHECK_CLAIMS_FETCH = 'FACT_CHECK_CLAIMS_FETCH';

export type FetchFn = typeof globalThis.fetch;

/**
 * One ClaimReview, flattened out of the `claims[].claimReview[]` nesting and
 * carrying its parent claim's context.
 *
 * FIELD NAMES ARE GOOGLE'S, NOT OURS. This route is a proxy, and the app maps
 * `publisher.name → organisation` / `textualRating → verdict` on its own side.
 * Renaming here would put a domain decision in the one place that cannot see
 * the domain, and would silently diverge from the upstream docs the next reader
 * will check.
 */
export interface ClaimReviewItem {
  /** `claims[].text` — the claim as the fact-checker stated it. */
  claim: string;
  /** `claims[].claimant` — who made it. `''` when upstream omits it. */
  claimant: string;
  /** `claims[].claimDate` — RFC 3339, or `''`. */
  claimDate: string;
  publisher: { name: string; site: string };
  url: string;
  title: string;
  reviewDate: string;
  /** The organisation's OWN wording — "Pants on Fire", "Mostly False". Never
   *  normalised here: verbatim attribution is the entire value of this route
   *  over asking a model to guess who ruled what. */
  textualRating: string;
  languageCode: string;
}

/** Mirrors `MIN_QUERY_LENGTH` in web-search — shorter is noise, not a claim. */
export const MIN_CLAIM_QUERY_LENGTH = 2;

/**
 * Longer than web-search's 200 ON PURPOSE. A search query is built short; a
 * *claim* is a sentence a person asserted, and truncating one mid-clause would
 * change what was looked up while still reporting success.
 */
export const MAX_CLAIM_QUERY_LENGTH = 300;

/** What we ask Google for. Not caller-settable — no `pageSize` in the DTO. */
export const CLAIMS_PAGE_SIZE = 10;

/** Hard cap on the FLATTENED list. One claim can carry several reviews, so 10
 *  claims can exceed 10 rows; this bounds what reaches a prompt. */
export const MAX_CLAIM_REVIEWS = 20;

const CLAIMS_ENDPOINT = 'https://factchecktools.googleapis.com/v1alpha1/claims:search';

/** Same deadline as the Brave proxy — a lookup a user is waiting on. */
const REQUEST_TIMEOUT_MS = 8_000;

interface RawPublisher {
  name?: unknown;
  site?: unknown;
}

interface RawClaimReview {
  publisher?: RawPublisher;
  url?: unknown;
  title?: unknown;
  reviewDate?: unknown;
  textualRating?: unknown;
  languageCode?: unknown;
}

interface RawClaim {
  text?: unknown;
  claimant?: unknown;
  claimDate?: unknown;
  claimReview?: RawClaimReview[];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Authenticated proxy in front of Google's Fact Check Tools API
 * (`v1alpha1/claims:search`), which serves the ClaimReview structured data every
 * IFCN signatory publishes.
 *
 * WHY A PROXY AT ALL: identical to the Brave route. `FACT_CHECK_TOOLS_API_KEY`
 * must never reach a client — a key shipped in an app binary is a public key.
 *
 * WHY THIS ROUTE EXISTS AT ALL: so "which organisation checked this" is a
 * structured lookup rather than a model's inference. An organisation returned
 * from this index cannot be hallucinated, and `textualRating` is already the
 * publisher's own verdict wording.
 *
 * THE KEY RIDES IN THE URL, WHICH THE BRAVE ROUTE'S DID NOT. Google takes
 * `?key=`, so the request URL contains BOTH the secret AND the plaintext claim
 * in one string. It is therefore never logged, never put in an exception
 * message, and never interpolated into an error — not truncated, not at debug.
 * Log method, status, elapsed and lengths only, and never alongside a user id:
 * the gateway keeps no association between a user and a lookup.
 *
 * DISABLED IS NOT EMPTY — see `../search-unavailable.ts`. `{ claimReviews: [] }`
 * with a 200 means one thing only: we asked the index and no IFCN signatory has
 * published on this claim. That is a fact, and it is the ~96% case. Every state
 * in which we did NOT ask throws 503 `search-unavailable` instead.
 */
@Injectable()
export class FactCheckClaimsService {
  private readonly logger = new Logger(FactCheckClaimsService.name);
  private readonly enabled: boolean;
  private readonly apiKey: string;

  constructor(
    private readonly configService: ConfigService,
    @Inject(FACT_CHECK_CLAIMS_FETCH) private readonly fetchFn: FetchFn,
  ) {
    // Spend/quota gate, default off — same posture as BRAVE_SEARCH_ENABLED.
    // The Fact Check Tools API publishes no rate limit, so an unmetered default
    // would be a promise we cannot keep.
    this.enabled =
      String(
        this.configService.get<string | boolean>('FACT_CHECK_TOOLS_ENABLED', false),
      ).toLowerCase() === 'true';
    // Empty default rather than a construction-time throw: this feature is
    // optional and off by default, so a missing key must not stop the gateway
    // from booting.
    this.apiKey = this.configService.get<string>('FACT_CHECK_TOOLS_API_KEY', '');
  }

  async searchClaims(
    query: string,
    languageCode?: string,
    maxAgeDays?: number,
  ): Promise<ClaimReviewItem[]> {
    const trimmed = (query ?? '').trim();

    if (trimmed.length < MIN_CLAIM_QUERY_LENGTH) {
      throw new BadRequestException(`Query must be at least ${MIN_CLAIM_QUERY_LENGTH} characters`);
    }
    if (trimmed.length > MAX_CLAIM_QUERY_LENGTH) {
      throw new BadRequestException(`Query must be at most ${MAX_CLAIM_QUERY_LENGTH} characters`);
    }

    // Gate AFTER validation but BEFORE the key is used or any request is made.
    if (!this.enabled) {
      this.logger.log('fact check claims disabled (FACT_CHECK_TOOLS_ENABLED is not true)');
      throw searchUnavailable('disabled', 'Fact check lookup is disabled on this gateway');
    }

    if (!this.apiKey) {
      this.logger.error(
        'FACT_CHECK_TOOLS_ENABLED is true but FACT_CHECK_TOOLS_API_KEY is not configured',
      );
      throw searchUnavailable('not-configured', 'Fact check lookup is not configured');
    }

    const url = new URL(CLAIMS_ENDPOINT);
    url.searchParams.set('query', trimmed);
    url.searchParams.set('pageSize', String(CLAIMS_PAGE_SIZE));
    // Absent languageCode is a VALID request, not a defaulted one: the app
    // retries a locale-scoped miss with it unset, because ClaimReview skews
    // heavily English and a locale filter can turn a real hit into a false
    // "nobody checked this".
    if (languageCode) url.searchParams.set('languageCode', languageCode);
    if (typeof maxAgeDays === 'number') url.searchParams.set('maxAgeDays', String(maxAgeDays));
    url.searchParams.set('key', this.apiKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const startedAt = Date.now();

    try {
      // GET with no body — API-key auth, exactly as the upstream docs specify.
      const response = await this.fetchFn(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });

      if (!response.ok) {
        // Status only, never the body: a Google error body echoes the request
        // back, and the request URL holds both the key and the claim.
        if (response.status === 401 || response.status === 403) {
          this.logger.error(
            `Fact Check Tools rejected our credentials (status ${response.status})`,
          );
          throw searchUnavailable('upstream-rejected-key', 'Fact check lookup is not configured');
        }
        // The quota on this API is undocumented, so 429 is a live risk. It must
        // surface as "we could not look", never as "no organisation has ruled".
        if (response.status === 429) {
          this.logger.warn('Fact Check Tools rate-limited this gateway (429)');
          throw searchUnavailable(
            'upstream-rate-limited',
            'Fact check lookup is rate-limited upstream',
          );
        }
        throw new Error(`Fact check claims lookup failed with status ${response.status}`);
      }

      const body = (await response.json()) as { claims?: RawClaim[] };
      const claims = Array.isArray(body?.claims) ? body.claims : [];

      // THE HONEST EMPTY. Google returns `{}` (no `claims` key at all) for a
      // query no signatory has reviewed. A 200 with `[]` is that answer, and it
      // is the normal outcome for most news — see the coverage measurement in
      // the wave plan. It is NOT a failure and must not be rendered as one.
      const flattened: ClaimReviewItem[] = [];
      for (const claim of claims) {
        const reviews = Array.isArray(claim?.claimReview) ? claim.claimReview : [];
        for (const review of reviews) {
          const reviewUrl = str(review?.url);
          // A review with no link is unattributable — the reader cannot check
          // it, so it is worse than absent.
          if (!reviewUrl) continue;
          flattened.push({
            claim: str(claim?.text),
            claimant: str(claim?.claimant),
            claimDate: str(claim?.claimDate),
            publisher: {
              name: str(review?.publisher?.name),
              site: str(review?.publisher?.site),
            },
            url: reviewUrl,
            title: str(review?.title),
            reviewDate: str(review?.reviewDate),
            textualRating: str(review?.textualRating),
            languageCode: str(review?.languageCode),
          });
          if (flattened.length >= MAX_CLAIM_REVIEWS) break;
        }
        if (flattened.length >= MAX_CLAIM_REVIEWS) break;
      }

      this.logger.debug(
        `fact check claims responded status=${response.status} elapsedMs=${Date.now() - startedAt} ` +
          `queryLength=${trimmed.length} claims=${claims.length} reviews=${flattened.length}`,
      );
      return flattened;
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      if ((error as { name?: string })?.name === 'AbortError') {
        throw new Error(
          `Fact check claims lookup timed out after ${elapsedMs}ms (limit=${REQUEST_TIMEOUT_MS}ms)`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
