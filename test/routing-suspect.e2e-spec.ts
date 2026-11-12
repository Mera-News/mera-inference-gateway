import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { RoutingService } from './../src/routing/routing.service';

/**
 * The passive suspect probe against a REAL BullMQ queue. The unit spec fakes
 * `queue.add`, so it cannot see BullMQ reject a job id; this suite can.
 */
describe('RoutingService suspect probe on real BullMQ (e2e)', () => {
  const redisUrl = process.env.MERA_E2E_REDIS_URL ?? 'redis://localhost:6379';
  const prefix = `bull-e2e-suspect-${process.pid}-${Date.now()}`;
  let connection: Redis;
  let client: Redis;
  let queue: Queue;
  let svc: RoutingService;
  let errorSpy: jest.SpyInstance;

  beforeAll(() => {
    connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    client = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    queue = new Queue('routing-probe', { connection, prefix });
    const values: Record<string, string> = { BULLMQ_PREFIX: prefix };
    const config = { get: (k: string, fb?: unknown) => values[k] ?? fb } as ConfigService;
    svc = new RoutingService(config, queue, client);
  });

  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => errorSpy.mockRestore());

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await connection.quit();
    await client.quit();
  });

  it('queues one probe for a burst of failures, with no error logged', async () => {
    svc.reportFailure('near', 'Qwen/Qwen3.8-27B');
    svc.reportFailure('near', 'Qwen/Qwen3.8-27B');

    let job = await queue.getJob('suspect-near/qwen3.8-27b');
    for (let i = 0; !job && i < 50; i++) {
      await new Promise((r) => setTimeout(r, 20));
      job = await queue.getJob('suspect-near/qwen3.8-27b');
    }
    // Let the second add settle before counting.
    await new Promise((r) => setTimeout(r, 200));

    expect(job?.data).toEqual({ profile: 'near/qwen3.8-27b' });
    expect(await queue.getJobCounts('waiting')).toEqual({ waiting: 1 });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('BullMQ still rejects the old two-part id, so the fix stays needed', async () => {
    await expect(queue.add('probe', {}, { jobId: 'suspect:near/qwen3.8-27b' })).rejects.toThrow(
      'Custom Id cannot contain :',
    );
  });
});
