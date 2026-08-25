import { ServiceUnavailableException } from '@nestjs/common';

/**
 * THE ONE RULE BOTH SEARCH ROUTES OBEY
 * ------------------------------------
 * *No configuration state may produce a response a caller can mistake for
 * "we searched and found nothing."*
 *
 * A fact-checker that cannot tell "nobody has published on this claim" apart
 * from "I was never able to look" is not a fact-checker — it manufactures a
 * green all-clear out of a missing env var. `/v1/web-search` used to do exactly
 * that: it returned `{ results: [] }` when its own spend gate was off, which is
 * byte-identical to a real zero-hit search.
 *
 * So the distinction lives in the STATUS CODE, never in the array length:
 *
 *   200 + `[]`  →  we searched, upstream had nothing. A real, honest result.
 *   503 + code  →  we did not search. Never a result of any kind.
 *
 * That second line is why this helper is shared rather than copy-pasted: both
 * routes must emit a byte-identical envelope, because the app branches on it to
 * decide between "no fact-checker has ruled on this" and "blocked". Two
 * near-identical literals would be three lines cheaper and one silent
 * divergence away from the failure this file exists to prevent.
 *
 * The wire body (after `HttpExceptionFilter` merges the extra keys) is:
 *
 *   { "code": "search-unavailable", "reason": "<why>", "statusCode": 503,
 *     "message": "...", "timestamp": "...", "path": "/v1/..." }
 *
 * `code` is the stable machine-readable contract; `reason` is a coarse
 * diagnostic and must never carry the query text, the API key, or a user id.
 */
export const SEARCH_UNAVAILABLE_CODE = 'search-unavailable';

/**
 * Every state in which the gateway did NOT reach the upstream index.
 * Deliberately coarse — a caller only needs "we could not look", and anything
 * finer starts describing our configuration to the internet.
 */
export type SearchUnavailableReason =
  /** The feature's own spend gate is off (`*_ENABLED` is not `true`). */
  | 'disabled'
  /** The gate is on but no API key is configured — a deploy-order mistake. */
  | 'not-configured'
  /** Upstream rejected our credentials (401/403). A wrong or revoked key. */
  | 'upstream-rejected-key'
  /** Upstream rate-limited us (429). Transient, and never "no results". */
  | 'upstream-rate-limited'
  /**
   * Upstream failed for any other reason — a timeout, or a status we do not
   * classify. Reachable ONLY per-entry in a multi-query search, where one
   * query's failure must not fail the others: a single-query request still
   * turns the same condition into a 502, because there the caller has nothing
   * else in the response to read.
   */
  | 'upstream-failed';

/**
 * Builds the 503 both search routes throw. Thrown from the SERVICE so the
 * controllers' `if (error instanceof HttpException) throw error` passes it
 * through verbatim instead of flattening it into a 502.
 */
export function searchUnavailable(
  reason: SearchUnavailableReason,
  message: string,
): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: SEARCH_UNAVAILABLE_CODE,
    reason,
    message,
  });
}
