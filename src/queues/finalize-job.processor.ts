import { Inject, Logger } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { JOB_STORE, type JobStore } from '../inference-jobs/job-store.port';
import { DEFAULT_JOB_OPTS, FINALIZE_JOB_QUEUE, NOTIFY_USER_QUEUE } from './queues.constants';

interface JobData {
  jobId: string;
}

/**
 * BullMQ Flow parent. Fires only after all llm-inference children complete
 * (BullMQ guarantees this ordering). Marks the job completed in the store
 * and hands off to the separate notify-user queue for push delivery.
 */
@Processor(FINALIZE_JOB_QUEUE)
export class FinalizeJobProcessor extends WorkerHost {
  private readonly logger = new Logger(FinalizeJobProcessor.name);

  constructor(
    @Inject(JOB_STORE) private readonly store: JobStore,
    @InjectQueue(NOTIFY_USER_QUEUE)
    private readonly notifyUserQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<JobData>): Promise<{ jobId: string }> {
    const { jobId } = job.data;

    const counts = await this.store.finalizeJob(jobId);
    if (!counts) {
      throw new Error(`Inference job ${jobId} not found at finalize`);
    }

    this.logger.log(
      `finalized jobId=${jobId} requests=${counts.requestCount} results=${counts.resultCount}`,
    );

    await this.notifyUserQueue.add('notify-user', { jobId }, DEFAULT_JOB_OPTS);

    return { jobId };
  }
}
