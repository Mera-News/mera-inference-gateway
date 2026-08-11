import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

/**
 * Body of `POST /v1/fact-check-claims`. The query is **plaintext**, for the same
 * unavoidable reason `/v1/web-search`'s is: a third-party index cannot be
 * queried with ciphertext. Nothing beyond these three fields is accepted — the
 * global `ValidationPipe` (`whitelist: true`) strips anything else a client
 * sends, so no user id, article id, or persona can ride along even by accident.
 *
 * Length bounds live in `FactCheckClaimsService`, not here, so trimming happens
 * first and there is a single source of truth for both limits.
 */
export class FactCheckClaimsRequestDto {
  @IsString()
  query!: string;

  /**
   * BCP-47, e.g. `en`, `pt-BR`. **Optional on purpose** — an absent
   * languageCode is a valid, deliberate request: the ClaimReview corpus skews
   * heavily English, so a caller that got nothing for its locale retries with
   * this unset rather than reporting "nobody checked this".
   *
   * Shape-constrained rather than enumerated: the app supports 20 locales today
   * and the upstream index has more, so a whitelist would reject valid lookups.
   * The pattern is what keeps a hostile value from being anything but a tag.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/, {
    message: 'languageCode must be a BCP-47 language tag',
  })
  languageCode?: string;

  /** Upstream's own filter: only reviews published within this many days.
   *  `@Type` is required — the global pipe transforms, and a JSON string here
   *  would otherwise fail `@IsInt` for a caller that sent `"30"`. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  maxAgeDays?: number;
}
