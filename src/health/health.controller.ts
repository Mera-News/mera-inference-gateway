import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { JOB_STORE, type JobStore } from '../inference-jobs/job-store.port';

// Probes must never consume anyone's rate-limit budget, and a 429 here would
// read as an unhealthy instance. Rate limits are keyed by principal and /health
// is unauthenticated, so without this every probe lands in one shared IP bucket.
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(@Inject(JOB_STORE) private readonly store: JobStore) {}

  // Cloud Run's STARTUP probe hits this (there is no liveness probe in either
  // Terraform root): failing when the job store is unreachable keeps a broken
  // revision from serving, and Cloud Run holds the previous one.
  //
  // Deliberately only the job store. The throttle Redis is NOT pinged here --
  // that store fails open by design, so its availability must never gate the
  // probe and take down a revision over a dependency it can live without.
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
