import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { JOB_STORE, type JobStore } from '../inference-jobs/job-store.port';
import { ExpoPushService } from '../notifications/expo-push.service';
import { NOTIFY_USER_QUEUE } from './queues.constants';

interface JobData {
  jobId: string;
}

@Processor(NOTIFY_USER_QUEUE, { concurrency: 2 })
export class NotifyUserProcessor extends WorkerHost {
  private readonly logger = new Logger(NotifyUserProcessor.name);

  constructor(
    @Inject(JOB_STORE) private readonly store: JobStore,
    private readonly push: ExpoPushService,
  ) {
    super();
  }

  async process(job: Job<JobData>): Promise<{ ok: true }> {
    const { jobId } = job.data;

    const info = await this.store.getNotifyInfo(jobId);
    if (!info) {
      throw new Error(`Inference job ${jobId} not found at notify-user`);
    }

    // Tokenless job — the client submitted without a push token and will
    // retrieve results by polling. Nothing to notify.
    if (!info.expoPushToken) {
      this.logger.log(`jobId=${jobId} has no push token — skipping notify (client polls)`);
      return { ok: true };
    }

    await this.push.sendSilent({
      to: info.expoPushToken,
      data: { type: 'inference-done', requestId: jobId },
    });

    this.logger.log(`notified jobId=${jobId}`);
    return { ok: true };
  }
}
