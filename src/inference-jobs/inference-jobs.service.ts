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

@Injectable()
export class InferenceJobsService {
  private readonly logger = new Logger(InferenceJobsService.name);

  constructor(
    @Inject(JOB_STORE) private readonly store: JobStore,
    private readonly flow: FlowService,
    private readonly capabilityTokens: CapabilityTokenService,
  ) {}

  async submit(
    userId: string,
    dto: SubmitJobDto,
    idempotencyKey?: string,
  ): Promise<{ requestId: string; capabilityToken: string }> {
    if (!idempotencyKey) {
      return this.submitFresh(userId, dto);
    }
    return this.submitIdempotent(userId, dto, idempotencyKey);
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
  ): Promise<{ requestId: string; capabilityToken: string }> {
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

    // reservation.status === 'reserved' — we own the slot.
    try {
      const result = await this.submitFresh(userId, dto);
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
  ): Promise<{ requestId: string; capabilityToken: string }> {
    let requestId: string;
    try {
      requestId = await this.store.createJob({
        userId,
        expoPushToken: dto.expoPushToken ?? null,
        e2eeSession: toHeaderRecord(dto.e2eeSession),
        requests: dto.requests.map((r) => ({ id: r.id, body: r.body })),
        sharedSystem: dto.sharedSystem ?? null,
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
