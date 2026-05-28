import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export const MAX_REQUESTS_PER_JOB = 5000;

/**
 * Upper bound on the shared system ciphertext. The plaintext scoring /
 * reason system prompts are ~8 KB; ciphertext inflates modestly. 64 KB is
 * generous and bounds the request footprint defensively.
 */
export const MAX_SHARED_SYSTEM_BYTES = 64 * 1024;

/**
 * One inference call inside a job. Shape mirrors an OpenAI chat.completions
 * request body, with an `id` the client uses to correlate results back. The
 * `messages[].content` is E2EE-encrypted ciphertext — the gateway never reads
 * or transforms it.
 */
export class InferenceRequestDto {
  @IsString()
  id!: string;

  @IsDefined()
  // Body is passed through upstream. We validate that it's an object but
  // don't constrain the shape — the upstream schema can evolve.
  body!: Record<string, unknown>;
}

/** E2EE session — same headers used for every request in the batch.
 *  Forwarded verbatim to the upstream when each request runs. */
export class E2EESessionDto {
  @IsOptional()
  @IsString()
  'X-Signing-Algo'?: string;

  @IsOptional()
  @IsString()
  'X-Client-Pub-Key'?: string;

  @IsOptional()
  @IsString()
  'X-Model-Pub-Key'?: string;

  @IsOptional()
  @IsString()
  'X-Encryption-Version'?: string;
}

export class SubmitJobDto {
  @IsString()
  @Matches(/^ExponentPushToken\[.+\]$|^ExpoPushToken\[.+\]$/, {
    message: 'expoPushToken must be a valid Expo push token',
  })
  expoPushToken!: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => E2EESessionDto)
  e2eeSession?: E2EESessionDto;

  /**
   * Optional E2EE-encrypted system message shared across every request in
   * the job. When set, the processor prepends a `{role:'system', content:
   * <sharedSystem>}` entry to each proxied request's `messages` array
   * before forwarding upstream. Lets clients send the system prompt once
   * instead of duplicating it per-request (saves ~37–44% of raw body for
   * the mera-app scoring / reason batches). The gateway never reads the
   * ciphertext.
   */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SHARED_SYSTEM_BYTES)
  sharedSystem?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_REQUESTS_PER_JOB)
  @ValidateNested({ each: true })
  @Type(() => InferenceRequestDto)
  requests!: InferenceRequestDto[];
}
