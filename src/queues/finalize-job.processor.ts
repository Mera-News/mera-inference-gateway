import { Logger } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Job, Queue } from 'bullmq';
import { InferenceJob, InferenceJobDocument } from '../inference-jobs/inference-job.schema';
import { DEFAULT_JOB_OPTS, FINALIZE_JOB_QUEUE, NOTIFY_USER_QUEUE } from './queues.constants';

interface JobData {
  jobId: string;
}

/**
 * BullMQ Flow parent. Fires only after all llm-inference children complete
 * (BullMQ guarantees this ordering). Marks the Mongo doc as completed and
 * hands off to the separate notify-user queue for push delivery.
 */
@Processor(FINALIZE_JOB_QUEUE)
export class FinalizeJobProcessor extends WorkerHost {
  private readonly logger = new Logger(FinalizeJobProcessor.name);

  constructor(
    @InjectModel(InferenceJob.name)
    private readonly inferenceJobModel: Model<InferenceJobDocument>,
    @InjectQueue(NOTIFY_USER_QUEUE)
    private readonly notifyUserQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<JobData>): Promise<{ jobId: string }> {
    const { jobId } = job.data;

    const updated = await this.inferenceJobModel
      .findOneAndUpdate(
        { _id: new Types.ObjectId(jobId) },
        { $set: { status: 'completed', completedAt: new Date() } },
        { returnDocument: 'after', projection: { results: 1, requests: 1 } },
      )
      .lean()
      .exec();

    if (!updated) {
      throw new Error(`Inference job ${jobId} not found at finalize`);
    }

    this.logger.log(
      `finalized jobId=${jobId} requests=${updated.requests.length} results=${updated.results.length}`,
    );

    await this.notifyUserQueue.add('notify-user', { jobId }, DEFAULT_JOB_OPTS);

    return { jobId };
  }
}
