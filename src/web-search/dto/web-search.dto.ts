import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, ValidateIf } from 'class-validator';
import { MAX_BATCH_QUERIES } from '../web-search.service';

/**
 * Body of `POST /v1/web-search`. The query is **plaintext** — see the
 * privacy note on `WebSearchService`: a third-party search API cannot be
 * queried with ciphertext, so this route is a deliberate, opt-in exception to
 * the gateway's E2EE-passthrough posture. Nothing else is accepted; the global
 * `ValidationPipe` (`whitelist: true`) strips any other property before it
 * reaches the controller.
 *
 * TWO SHAPES, EXACTLY ONE PER REQUEST:
 *
 *   { "query": "one thing" }          → 200 { results: [...] }
 *   { "queries": ["a", "b", "c"] }    → 200 { searches: [...] }
 *
 * Both fields are optional HERE and the exclusivity is enforced in the
 * controller, because class-validator cannot express "exactly one of" without
 * a custom validator, and a wrong answer to that question has to be a 400 with
 * a sentence in it rather than a schema error nobody can act on.
 *
 * THE SINGLE-QUERY SHAPE IS FROZEN. An app build older than this change sends
 * `{ query }` and must keep getting `{ results }` byte-for-byte — the client
 * treats a 400 on the multi-query shape as "this gateway predates batching"
 * and falls back to one call per query, so the old path breaking would strand
 * the fallback too.
 *
 * Length bounds are enforced in `WebSearchService`, not here, so that trimming
 * happens first and there is a single source of truth for both limits.
 */
export class WebSearchRequestDto {
  // `ValidateIf`, not `IsOptional`: IsOptional also waves through an explicit
  // `null`, and `{"query": null}` is a client bug that should be told so at the
  // schema rather than surfacing as a length complaint two layers down.
  @ValidateIf((o: WebSearchRequestDto) => o.query !== undefined)
  @IsString()
  query?: string;

  /** Fanned out concurrently by the service. `MAX_BATCH_QUERIES` is the spend
   *  ceiling per request — batching removes waiting, not cost. */
  @ValidateIf((o: WebSearchRequestDto) => o.queries !== undefined)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BATCH_QUERIES)
  @IsString({ each: true })
  queries?: string[];
}
