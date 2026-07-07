import {
  Inject,
  Injectable,
  Logger,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
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
