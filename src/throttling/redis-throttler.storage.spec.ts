import { RedisThrottlerStorage } from './redis-throttler.storage';

interface FakeRedis {
  defineCommand: jest.Mock;
  throttleIncr: jest.Mock;
  quit: jest.Mock;
  disconnect: jest.Mock;
}

function fakeRedis(): FakeRedis {
  return {
    defineCommand: jest.fn(),
    throttleIncr: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
    disconnect: jest.fn(),
  };
}

const PREFIX = 'bull:throttle:';
const TTL_MS = 60_000;

function make(redis: FakeRedis) {
  return new RedisThrottlerStorage(redis as never, PREFIX);
}

describe('RedisThrottlerStorage', () => {
  it('registers the atomic INCR + PEXPIRE script once, on one key', () => {
    const redis = fakeRedis();
    make(redis);
    expect(redis.defineCommand).toHaveBeenCalledTimes(1);
    const [name, opts] = redis.defineCommand.mock.calls[0] as [
      string,
      { numberOfKeys: number; lua: string },
    ];
    expect(name).toBe('throttleIncr');
    expect(opts.numberOfKeys).toBe(1);
    expect(opts.lua).toContain('INCR');
    expect(opts.lua).toContain('PEXPIRE');
  });

  it('namespaces the key with the configured prefix', async () => {
    const redis = fakeRedis();
    redis.throttleIncr.mockResolvedValue([1, TTL_MS]);
    await make(redis).increment('abc123', TTL_MS, 90);
    expect(redis.throttleIncr).toHaveBeenCalledWith(`${PREFIX}abc123`, TTL_MS);
  });

  describe('units: ttl arrives in MILLISECONDS, timeToExpire returns SECONDS', () => {
    it('converts the remaining PTTL to whole seconds', async () => {
      const redis = fakeRedis();
      redis.throttleIncr.mockResolvedValue([3, 45_000]);
      const r = await make(redis).increment('k', TTL_MS, 90);
      expect(r.timeToExpire).toBe(45);
    });

    it('rounds a partial second up', async () => {
      const redis = fakeRedis();
      redis.throttleIncr.mockResolvedValue([1, 1_200]);
      const r = await make(redis).increment('k', TTL_MS, 90);
      expect(r.timeToExpire).toBe(2);
    });

    it.each([-1, -2])('falls back to the full window when PTTL is %s', async (pttl) => {
      const redis = fakeRedis();
      redis.throttleIncr.mockResolvedValue([1, pttl]);
      const r = await make(redis).increment('k', TTL_MS, 90);
      expect(r.timeToExpire).toBe(60);
    });
  });

  describe('blocking', () => {
    it('is not blocked while hits are at or under the limit', async () => {
      const redis = fakeRedis();
      redis.throttleIncr.mockResolvedValue([90, TTL_MS]);
      const r = await make(redis).increment('k', TTL_MS, 90);
      expect(r).toMatchObject({ totalHits: 90, isBlocked: false, timeToBlockExpire: 0 });
    });

    it('blocks on the first hit past the limit', async () => {
      const redis = fakeRedis();
      redis.throttleIncr.mockResolvedValue([91, 30_000]);
      const r = await make(redis).increment('k', TTL_MS, 90);
      expect(r).toMatchObject({ totalHits: 91, isBlocked: true, timeToBlockExpire: 30 });
    });

    it('coerces a string limit (ConfigService does not coerce env values)', async () => {
      const redis = fakeRedis();
      redis.throttleIncr.mockResolvedValue([10, TTL_MS]);
      const r = await make(redis).increment('k', TTL_MS, '9' as never);
      expect(r.isBlocked).toBe(true);
    });
  });

  describe('fails OPEN', () => {
    it('allows the request when Redis rejects (connection refused)', async () => {
      const redis = fakeRedis();
      redis.throttleIncr.mockRejectedValue(new Error('ECONNREFUSED'));
      const r = await make(redis).increment('k', TTL_MS, 90);
      expect(r).toEqual({
        totalHits: 0,
        timeToExpire: 60,
        isBlocked: false,
        timeToBlockExpire: 0,
      });
    });

    // The failure that actually bites under a burst: Redis responds, slowly.
    // commandTimeout turns that into a rejection, which must also fail open.
    it('allows the request when the command TIMES OUT rather than throwing early', async () => {
      const redis = fakeRedis();
      redis.throttleIncr.mockRejectedValue(new Error('Command timed out'));
      const r = await make(redis).increment('k', TTL_MS, 90);
      expect(r.isBlocked).toBe(false);
      expect(r.totalHits).toBe(0);
    });

    it('never rethrows, so a Redis outage cannot 5xx a request', async () => {
      const redis = fakeRedis();
      redis.throttleIncr.mockRejectedValue(new Error('boom'));
      await expect(make(redis).increment('k', TTL_MS, 90)).resolves.toBeDefined();
    });
  });

  describe('logs on state TRANSITION, not once and not per request', () => {
    it('warns once across a run of failures, then logs recovery', async () => {
      const redis = fakeRedis();
      const storage = make(redis);
      const warn = jest.spyOn(storage['logger'], 'warn').mockImplementation(() => undefined);
      const log = jest.spyOn(storage['logger'], 'log').mockImplementation(() => undefined);

      redis.throttleIncr.mockRejectedValue(new Error('down'));
      await storage.increment('k', TTL_MS, 90);
      await storage.increment('k', TTL_MS, 90);
      await storage.increment('k', TTL_MS, 90);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();

      redis.throttleIncr.mockResolvedValue([1, TTL_MS]);
      await storage.increment('k', TTL_MS, 90);
      expect(log).toHaveBeenCalledTimes(1);

      // And it can warn again on the NEXT outage -- not a one-shot latch.
      redis.throttleIncr.mockRejectedValue(new Error('down again'));
      await storage.increment('k', TTL_MS, 90);
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('stays quiet while healthy', async () => {
      const redis = fakeRedis();
      const storage = make(redis);
      const warn = jest.spyOn(storage['logger'], 'warn').mockImplementation(() => undefined);
      const log = jest.spyOn(storage['logger'], 'log').mockImplementation(() => undefined);
      redis.throttleIncr.mockResolvedValue([1, TTL_MS]);
      await storage.increment('k', TTL_MS, 90);
      await storage.increment('k', TTL_MS, 90);
      expect(warn).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('shutdown', () => {
    it('quits the client (main.ts enables shutdown hooks)', async () => {
      const redis = fakeRedis();
      await make(redis).onApplicationShutdown();
      expect(redis.quit).toHaveBeenCalled();
      expect(redis.disconnect).not.toHaveBeenCalled();
    });

    it('force-disconnects if quit fails, so no handle leaks', async () => {
      const redis = fakeRedis();
      redis.quit.mockRejectedValue(new Error('already closed'));
      await make(redis).onApplicationShutdown();
      expect(redis.disconnect).toHaveBeenCalled();
    });
  });
});
