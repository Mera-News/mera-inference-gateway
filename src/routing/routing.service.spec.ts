import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';

const RedisMock = require('ioredis-mock');
import { RoutingService } from './routing.service';

const NEAR = 'near/qwen3.8-27b';
const NEAR_MODEL = 'Qwen/Qwen3.8-27B';

function setup(env: Record<string, string> = {}) {
  const redis = new RedisMock();
  const queue = {
    waitUntilReady: jest.fn().mockResolvedValue(redis),
    add: jest.fn().mockResolvedValue(undefined),
    upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
  };
  const values: Record<string, string> = {
    NEAR_AI_API_KEY: 'n',
    REDPILL_API_KEY: 'r',
    BULLMQ_PREFIX: 'bull-test',
    ...env,
  };
  const config = {
    get: (k: string, fb?: unknown) => values[k] ?? fb,
  } as unknown as ConfigService;
  const svc = new RoutingService(config, queue as unknown as Queue);
  return { svc, queue, redis };
}

describe('RoutingService', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(async () => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    await new RedisMock().flushall();
  });
  afterEach(() => jest.restoreAllMocks());

  it('starts with every profile up, version 0, every lane ok', async () => {
    const { svc } = setup();
    const body = await svc.body();
    expect(body.version).toBe(0);
    expect(body.lanes['chat-tools']).toEqual({
      state: 'ok',
      profiles: ['near/qwen3.8-27b', 'near/qwen3.6-35b-a3b', 'redpill/qwen3.8-27b'],
    });
    expect(body.lanes.scoring.profiles[0]).toBe('near/qwen3.6-35b-a3b');
    expect(await svc.isDown('near', NEAR_MODEL)).toBe(false);
  });

  it('goes down only after 2 failed probes, and logs one state change', async () => {
    const { svc } = setup();
    await svc.recordProbe(NEAR, false);
    expect((await svc.body()).version).toBe(0);
    await svc.recordProbe(NEAR, false);
    const body = await svc.body();
    expect(body.version).toBe(1);
    expect(body.lanes['chat-tools'].state).toBe('degraded');
    expect(body.lanes['chat-tools'].profiles[0]).toBe('near/qwen3.6-35b-a3b');
    expect(await svc.isDown('near', NEAR_MODEL)).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(`routing_state_change profile=${NEAR} from=up to=down`);
  });

  it('a pass between failures resets the count', async () => {
    const { svc } = setup();
    await svc.recordProbe(NEAR, false);
    await svc.recordProbe(NEAR, true);
    await svc.recordProbe(NEAR, false);
    expect(await svc.isDown('near', NEAR_MODEL)).toBe(false);
  });

  it('comes back only after 3 passing probes', async () => {
    const { svc } = setup();
    await svc.recordProbe(NEAR, false);
    await svc.recordProbe(NEAR, false);
    await svc.recordProbe(NEAR, true);
    await svc.recordProbe(NEAR, true);
    expect(await svc.isDown('near', NEAR_MODEL)).toBe(true);
    await svc.recordProbe(NEAR, true);
    expect(await svc.isDown('near', NEAR_MODEL)).toBe(false);
    expect((await svc.body()).version).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(`routing_state_change profile=${NEAR} from=down to=up`);
  });

  it('logs routing_all_down when the last profile goes down', async () => {
    const { svc } = setup();
    for (const id of ['near/qwen3.8-27b', 'near/qwen3.6-35b-a3b', 'redpill/qwen3.8-27b']) {
      await svc.setPin(id, 'down');
    }
    expect(errorSpy).toHaveBeenCalledWith('routing_all_down');
    const body = await svc.body();
    expect(body.lanes['chat-tools']).toEqual({ state: 'down', profiles: [] });
  });

  it('a pin overrides health and auto hands control back', async () => {
    const { svc } = setup();
    await svc.setPin(NEAR, 'down');
    expect(await svc.isDown('near', NEAR_MODEL)).toBe(true);
    // a passing probe cannot lift a pin
    await svc.recordProbe(NEAR, true);
    expect(await svc.isDown('near', NEAR_MODEL)).toBe(true);
    await svc.setPin(NEAR, 'auto');
    expect(await svc.isDown('near', NEAR_MODEL)).toBe(false);
    expect((await svc.body()).version).toBe(2);
  });

  it('an unset provider key reads as down, without a write or a crash', async () => {
    const { svc } = setup({ REDPILL_API_KEY: '' });
    expect(await svc.isDown('redpill', 'qwen/qwen3.8-27b')).toBe(true);
    const body = await svc.body();
    expect(body.lanes['chat-tools'].profiles).not.toContain('redpill/qwen3.8-27b');
    expect(body.version).toBe(0);
  });

  it('an unknown model is never down', async () => {
    const { svc } = setup();
    expect(await svc.isDown('near', 'some/other-model')).toBe(false);
  });

  it('a Redis outage serves every profile up and never throws', async () => {
    const { svc, queue } = setup();
    queue.waitUntilReady.mockRejectedValue(new Error('redis down'));
    expect((await svc.body()).lanes['chat-tools'].state).toBe('ok');
    expect(await svc.version()).toBe(0);
  });

  it('a passive failure queues one immediate probe under a deduping job id', () => {
    const { svc, queue } = setup();
    svc.reportFailure('near', NEAR_MODEL);
    svc.reportFailure('near', 'some/other-model');
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'probe',
      { profile: NEAR },
      expect.objectContaining({ jobId: `suspect:${NEAR}` }),
    );
  });

  it('schedules a 60s probe per profile at boot, unless probes are disabled', async () => {
    const on = setup();
    await on.svc.onApplicationBootstrap();
    expect(on.queue.upsertJobScheduler).toHaveBeenCalledTimes(3);
    expect(on.queue.upsertJobScheduler).toHaveBeenCalledWith(
      `probe:${NEAR}`,
      { every: 60_000 },
      expect.objectContaining({ data: { profile: NEAR } }),
    );
    const off = setup({ ROUTING_PROBES_ENABLED: 'false' });
    await off.svc.onApplicationBootstrap();
    expect(off.queue.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it('keys live under the BULLMQ_PREFIX namespace', async () => {
    const { svc, redis } = setup();
    await svc.setPin(NEAR, 'down');
    expect(await redis.hget('bull-test:routing-table:pins', NEAR)).toBe('down');
  });
});

describe('RoutingService.allDown', () => {
  it('is true only when every named model is down, or the provider has no key', async () => {
    const a = setup();
    await a.svc.setPin(NEAR, 'down');
    expect(await a.svc.allDown('near', [NEAR_MODEL])).toBe(true);
    expect(await a.svc.allDown('near', [NEAR_MODEL, 'Qwen/Qwen3.6-35B-A3B-FP8'])).toBe(false);
    expect(await a.svc.allDown('near', [])).toBe(false);
    const b = setup({ REDPILL_API_KEY: '' });
    expect(await b.svc.allDown('redpill', ['anything'])).toBe(true);
  });
});
