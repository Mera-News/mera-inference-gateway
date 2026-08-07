import { IsString } from 'class-validator';

/**
 * Body of `POST /v1/web-search`. The query is **plaintext** — see the
 * privacy note on `WebSearchService`: a third-party search API cannot be
 * queried with ciphertext, so this route is a deliberate, opt-in exception to
 * the gateway's E2EE-passthrough posture. Nothing else is accepted; the global
 * `ValidationPipe` (`whitelist: true`) strips any other property before it
 * reaches the controller.
 *
 * Length bounds are enforced in `WebSearchService`, not here, so that trimming
 * happens first and there is a single source of truth for both limits.
 */
export class WebSearchRequestDto {
  @IsString()
  query!: string;
}
