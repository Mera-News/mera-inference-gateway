import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { InferenceJob, InferenceJobDocument } from './inference-job.schema';
import { FlowService } from '../queues/flow.service';
import type { SubmitJobDto } from './dto/submit-job.dto';
import { CapabilityTokenService } from '../auth/capability-token.service';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class InferenceJobsService {
  private readonly logger = new Logger(InferenceJobsService.name);

  constructor(
    @InjectModel(InferenceJob.name)
    private readonly inferenceJobModel: Model<InferenceJobDocument>,
    private readonly flow: FlowService,
    private readonly capabilityTokens: CapabilityTokenService,
  ) {}

  async submit(
    userId: string,
    dto: SubmitJobDto,
  ): Promise<{ requestId: string; capabilityToken: string }> {
    const now = new Date();

    const doc = await this.inferenceJobModel.create({
      userId,
      expoPushToken: dto.expoPushToken,
      e2eeSession: dto.e2eeSession ?? null,
      status: 'pending',
      requests: dto.requests.map((r) => ({ id: r.id, body: r.body })),
      sharedSystem: dto.sharedSystem ?? null,
      results: [],
      createdAt: now,
      completedAt: null,
      expiresAt: new Date(now.getTime() + DEFAULT_TTL_MS),
    });

    const requestId = doc._id.toString();

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
