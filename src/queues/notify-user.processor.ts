import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Job } from 'bullmq';
import { InferenceJob, InferenceJobDocument } from '../models/inference-job.schema';
import { ExpoPushService } from '../notifications/expo-push.service';
import { NOTIFY_USER_QUEUE } from './queues.constants';

interface JobData {
  jobId: string;
}

@Processor(NOTIFY_USER_QUEUE, { concurrency: 2 })
export class NotifyUserProcessor extends WorkerHost {
  private readonly logger = new Logger(NotifyUserProcessor.name);

  constructor(
    @InjectModel(InferenceJob.name)
    private readonly inferenceJobModel: Model<InferenceJobDocument>,
    private readonly push: ExpoPushService,
  ) {
    super();
  }

  async process(job: Job<JobData>): Promise<{ ok: true }> {
    const { jobId } = job.data;

    const doc = await this.inferenceJobModel
      .findById(new Types.ObjectId(jobId), { expoPushToken: 1 })
      .lean()
      .exec();
    if (!doc) {
      throw new Error(`Inference job ${jobId} not found at notify-user`);
    }

    // Tokenless job — the client submitted without a push token and will
    // retrieve results by polling. Nothing to notify.
    if (!doc.expoPushToken) {
      this.logger.log(`jobId=${jobId} has no push token — skipping notify (client polls)`);
      return { ok: true };
    }

    await this.push.sendSilent({
      to: doc.expoPushToken,
      data: { type: 'inference-done', requestId: jobId },
    });

    this.logger.log(`notified jobId=${jobId}`);
    return { ok: true };
  }
}
