import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PROFILES } from './profiles';
import { probeProfile } from './probe';
import { ROUTING_PROBE_QUEUE, RoutingService } from './routing.service';

@Processor(ROUTING_PROBE_QUEUE, { concurrency: 3 })
export class ProbeProcessor extends WorkerHost {
  constructor(private readonly routing: RoutingService) {
    super();
  }

  async process(job: Job<{ profile: string }>): Promise<void> {
    const profile = PROFILES[job.data.profile];
    if (!profile) return;
    const key = this.routing.keyFor(profile.provider);
    // No key: the table already reads the profile as down, nothing to probe with.
    if (!key) return;
    await this.routing.recordProbe(job.data.profile, await probeProfile(job.data.profile, key));
  }
}
