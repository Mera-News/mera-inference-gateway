import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { JOB_STORE, type JobStore } from '../inference-jobs/job-store.port';

@Controller('health')
export class HealthController {
  constructor(@Inject(JOB_STORE) private readonly store: JobStore) {}

  // Cloud Run's startup probe hits this: failing when the job store is
  // unreachable keeps a broken instance from serving and recycles it.
  @Get()
  async check() {
    try {
      await this.store.ping();
    } catch {
      throw new ServiceUnavailableException({ status: 'error', jobStore: 'unreachable' });
    }
    return { status: 'ok' };
  }
}
