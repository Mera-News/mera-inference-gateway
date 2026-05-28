import { ConfigService } from '@nestjs/config';
import { InferenceQueueService } from './inference-queue.service';

function makeConfig(overrides: Record<string, number>): ConfigService {
  return {
    get: <T>(key: string, fallback: T): T => (overrides[key] as unknown as T) ?? fallback,
  } as unknown as ConfigService;
}

describe('InferenceQueueService', () => {
  it('caps concurrent executions to maxConcurrency', async () => {
    const queue = new InferenceQueueService(
      makeConfig({
        INFERENCE_MAX_CONCURRENCY: 2,
        INFERENCE_MAX_QUEUE_DEPTH: 100,
      }),
    );

    let inFlight = 0;
    let peak = 0;

    const task = async (i: number) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return i;
    };

    const results = await Promise.all([0, 1, 2, 3, 4].map((i) => queue.run(() => task(i))));

    expect(peak).toBeLessThanOrEqual(2);
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  it('preserves FIFO order for waiters', async () => {
    const queue = new InferenceQueueService(
      makeConfig({
        INFERENCE_MAX_CONCURRENCY: 1,
        INFERENCE_MAX_QUEUE_DEPTH: 100,
      }),
    );

    const completed: number[] = [];
    const release: Array<() => void> = [];

    const promises = [0, 1, 2, 3].map((i) =>
      queue.run(
        () =>
          new Promise<void>((resolve) => {
            release.push(() => {
              completed.push(i);
              resolve();
            });
          }),
      ),
    );

    // Let microtasks settle so the first task is active and the rest are parked.
    await new Promise((r) => setImmediate(r));

    while (release.length > 0) {
      release.shift()!();
      await new Promise((r) => setImmediate(r));
    }

    await Promise.all(promises);
    expect(completed).toEqual([0, 1, 2, 3]);
  });

  it('canAccept returns false once depth would be exceeded', async () => {
    const queue = new InferenceQueueService(
      makeConfig({
        INFERENCE_MAX_CONCURRENCY: 1,
        INFERENCE_MAX_QUEUE_DEPTH: 3,
      }),
    );

    let release!: () => void;
    const blocker = queue.run(() => new Promise<void>((resolve) => (release = resolve)));

    // Park two more so (active=1, waiting=2) = depth 3.
    const parked = [queue.run(() => Promise.resolve()), queue.run(() => Promise.resolve())];

    await new Promise((r) => setImmediate(r));

    expect(queue.canAccept(0)).toBe(true);
    expect(queue.canAccept(1)).toBe(false);

    release();
    await blocker;
    await Promise.all(parked);

    expect(queue.canAccept(3)).toBe(true);
    expect(queue.canAccept(4)).toBe(false);
  });

  it('releases slot even when the task throws', async () => {
    const queue = new InferenceQueueService(
      makeConfig({
        INFERENCE_MAX_CONCURRENCY: 1,
        INFERENCE_MAX_QUEUE_DEPTH: 10,
      }),
    );

    await expect(queue.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');

    expect(queue.snapshot()).toEqual({ active: 0, waiting: 0 });

    await expect(queue.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});
