import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { FlowService } from '../queues/flow.service';
import type { SubmitJobDto } from './dto/submit-job.dto';
import { CapabilityTokenService } from '../auth/capability-token.service';
import { JOB_STORE, JobPayloadTooLargeError, type JobStore } from './job-store.port';
import type { Tier } from '../auth/tier';
import { ReadMeterService, type MeterCharge } from './read-meter.service';

/**
 * Output ceiling stamped onto every request body (plaintext field, never the
 * ciphertext). The app's job calls ask for 320 (score) and 96 (note); a
 * missing value would let the model run to its own default.
 */
export const MAX_JOB_OUTPUT_TOKENS = 512;

/** Thrown when the caller's daily read budget cannot take this submit. */
export class DailyReadingExceededError extends Error {
  /** `nowMs` is Redis TIME at the refusal, so Retry-After and resetAt share a
   *  clock instead of mixing Redis time with this instance's. */
  constructor(
    readonly resetAt: Date,
    readonly nowMs: number,
  ) {
    super('daily reading limit reached');
    this.name = 'DailyReadingExceededError';
  }
}

export interface SubmitCaller {
  tier?: Tier;
  /** Capability-token submit: charged, but never raises the stored limit. */
  followup?: boolean;
}

export interface SubmitResult {
  requestId: string;
  capabilityToken: string;
  /** used / limit after this charge, capped at 1. Absent when the meter is
   *  off or this was an idempotent replay. */
  readingUsed?: number;
}

@Injectable()
export class InferenceJobsService {
  private readonly logger = new Logger(InferenceJobsService.name);

  constructor(
    @Inject(JOB_STORE) private readonly store: JobStore,
    private readonly flow: FlowService,
    private readonly capabilityTokens: CapabilityTokenService,
    private readonly meter: ReadMeterService,
  ) {}

  async submit(
    userId: string,
    dto: SubmitJobDto,
    idempotencyKey?: string,
    caller: SubmitCaller = {},
  ): Promise<SubmitResult> {
    if (!idempotencyKey) {
      return this.submitFresh(userId, dto, caller);
    }
    return this.submitIdempotent(userId, dto, idempotencyKey, caller);
  }

  /**
   * Idempotency-Key path. The header is validated (format) by the controller
   * before it reaches here; it's sha256-hashed so no client-supplied string
   * ever shapes a Redis key. Reserve -> create -> finalize, with the
   * reservation released on any throw so a crash between reserve and
   * finalize never blocks a retry for the rest of the 24h job window (only
   * for the 60s reservation TTL, as a backstop).
   */
  private async submitIdempotent(
    userId: string,
    dto: SubmitJobDto,
    idempotencyKey: string,
    caller: SubmitCaller,
  ): Promise<SubmitResult> {
    const keyHash = createHash('sha256').update(idempotencyKey).digest('hex');
    const reservation = await this.store.reserveIdempotencyKey(userId, keyHash);

    if (reservation.status === 'exists') {
      // Replay of an already-finalized submit: same requestId, freshly
      // minted token, no new flow.
      const capabilityToken = this.capabilityTokens.mint({
        userId,
        requestId: reservation.requestId,
      });
      this.logger.log(
        `Idempotent replay requestId=${reservation.requestId} userId=${userId} (no new flow)`,
      );
      return { requestId: reservation.requestId, capabilityToken };
    }

    if (reservation.status === 'in-progress') {
      throw new ConflictException({ code: 'idempotency-in-progress' });
    }

    // reservation.status === 'reserved' — we own the slot. Every throw below,
    // a meter refusal included, releases it so the same key can resubmit.
    try {
      const result = await this.submitFresh(userId, dto, caller);
      await this.store.finalizeIdempotencyKey(userId, keyHash, result.requestId);
      return result;
    } catch (err) {
      await this.store.releaseIdempotencyKey(userId, keyHash);
      throw err;
    }
  }

  private async submitFresh(
    userId: string,
    dto: SubmitJobDto,
    caller: SubmitCaller,
  ): Promise<SubmitResult> {
    const requests = dto.requests.map((r) => ({ id: r.id, body: clampOutputTokens(r.body) }));
    const sharedSystem = dto.sharedSystem ?? null;

    // What goes upstream: each body, plus the shared system prompt the worker
    // prepends to every one of them.
    const sharedBytes = sharedSystem ? Buffer.byteLength(sharedSystem) : 0;
    const cost = requests.reduce(
      (sum, r) => sum + Buffer.byteLength(JSON.stringify(r.body)) + sharedBytes,
      0,
    );

    let charged: MeterCharge | null = null;
    let readingUsed: number | undefined;
    try {
      const outcome = await this.meter.charge({
        userId,
        tier: caller.tier,
        cost,
        mayRaiseLimit: !caller.followup,
      });
      if (outcome.status === 'refused')
        throw new DailyReadingExceededError(outcome.resetAt, outcome.nowMs);
      if (outcome.status === 'charged') {
        charged = outcome.charge;
        readingUsed = Math.min(1, outcome.used / outcome.limit);
      }
    } catch (err) {
      if (err instanceof DailyReadingExceededError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`read meter unavailable at submit: ${msg}`);
      throw new ServiceUnavailableException('Job store unavailable');
    }

    try {
      const result = await this.createAndMint(userId, dto, requests, sharedSystem);
      return readingUsed === undefined ? result : { ...result, readingUsed };
    } catch (err) {
      if (charged) await this.meter.refund(charged);
      throw err;
    }
  }

  private async createAndMint(
    userId: string,
    dto: SubmitJobDto,
    requests: { id: string; body: Record<string, unknown> }[],
    sharedSystem: string | null,
  ): Promise<{ requestId: string; capabilityToken: string }> {
    let requestId: string;
    try {
      requestId = await this.store.createJob({
        userId,
        expoPushToken: dto.expoPushToken ?? null,
        e2eeSession: toHeaderRecord(dto.e2eeSession),
        requests,
        sharedSystem,
      });
    } catch (err) {
      if (err instanceof JobPayloadTooLargeError) {
        throw new PayloadTooLargeException(
          `Job payload of ${err.bytes} bytes exceeds the ${err.maxBytes}-byte limit`,
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`job store unavailable at submit: ${msg}`);
      throw new ServiceUnavailableException('Job store unavailable');
    }

    await this.flow.createInferenceFlow({
      jobId: requestId,
      requestCount: dto.requests.length,
    });

    const capabilityToken = this.capabilityTokens.mint({ userId, requestId });

    this.logger.log(
      `Submitted inference job requestId=${requestId} userId=${userId} total=${dto.requests.length}`,
    );

    return { requestId, capabilityToken };
  }
}

/**
 * Stamp MAX_JOB_OUTPUT_TOKENS on a request body: set when absent, lowered when
 * higher. Touches only the plaintext token fields, never `messages`.
 */
function clampOutputTokens(body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  const out: Record<string, unknown> = { ...body };
  const cap = (v: unknown) =>
    typeof v === 'number' && v <= MAX_JOB_OUTPUT_TOKENS ? v : MAX_JOB_OUTPUT_TOKENS;
  out.max_tokens = cap(body.max_tokens);
  if ('max_completion_tokens' in body) out.max_completion_tokens = cap(body.max_completion_tokens);
  return out;
}

/**
 * Collapse the optional E2EE-session DTO into the plain string record the
 * store persists — drop undefined props, null when no header is present.
 */
function toHeaderRecord(session: object | undefined): Record<string, string> | null {
  if (!session) return null;
  const record: Record<string, string> = {};
  for (const [k, v] of Object.entries(session)) {
    if (typeof v === 'string') record[k] = v;
  }
  return Object.keys(record).length > 0 ? record : null;
}
