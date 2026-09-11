/**
 * Exercises ThrottlingModule's provider factories directly. ioredis is mocked
 * so nothing dials a real server.
 */

const redisInstances: Array<{ url: string; options: Record<string, unknown>; on: jest.Mock }> = [];

jest.mock('ioredis', () => {
  return {
    __esModule: true,
    default: class RedisStub {
      on = jest.fn();
      constructor(url: string, options: Record<string, unknown>) {
        redisInstances.push({ url, options, on: this.on });
      }
    },
  };
});

import { ThrottlingModule, THROTTLE_REDIS_CLIENT } from './throttling.module';
import { RedisThrottlerStorage } from './redis-throttler.storage';

type Provider = {
  provide: unknown;
  inject: unknown[];
  useFactory: (...args: unknown[]) => unknown;
};

function providers(): Provider[] {
  return Reflect.getMetadata('providers', ThrottlingModule) as Provider[];
}

function factoryFor(token: unknown): Provider {
  const found = providers().find((p) => p.provide === token);
  if (!found) throw new Error('provider not found');
  return found;
}

function cfg(values: Record<string, unknown>) {
  return {
    get: (key: string, fallback?: unknown) => values[key] ?? fallback,
  };
}

describe('ThrottlingModule', () => {
  beforeEach(() => {
    redisInstances.length = 0;
  });

  it('exports the storage', () => {
    expect(Reflect.getMetadata('exports', ThrottlingModule)).toEqual([RedisThrottlerStorage]);
  });

  describe('redis client factory', () => {
    const build = (values: Record<string, unknown>) =>
      factoryFor(THROTTLE_REDIS_CLIENT).useFactory(cfg(values));

    it('throws when INFERENCE_REDIS_URL is unset', () => {
      expect(() => build({})).toThrow('INFERENCE_REDIS_URL is not set');
    });

    it('connects to INFERENCE_REDIS_URL (the shared BullMQ instance)', () => {
      build({ INFERENCE_REDIS_URL: 'redis://example:6379' });
      expect(redisInstances[0].url).toBe('redis://example:6379');
    });

    // These three are what make fail-open work for a SLOW Redis, not just an
    // unreachable one. Without them a burst stalls behind the rate limiter.
    it('bounds every command with a timeout', () => {
      build({ INFERENCE_REDIS_URL: 'redis://x:6379' });
      expect(redisInstances[0].options.commandTimeout).toBe(300);
    });

    it('disables the offline queue so disconnected commands reject at once', () => {
      build({ INFERENCE_REDIS_URL: 'redis://x:6379' });
      expect(redisInstances[0].options.enableOfflineQueue).toBe(false);
    });

    it('caps retries per request', () => {
      build({ INFERENCE_REDIS_URL: 'redis://x:6379' });
      expect(redisInstances[0].options.maxRetriesPerRequest).toBe(1);
    });

    // An unhandled ioredis 'error' event takes the process down, which would
    // be the opposite of failing open.
    it('attaches an error listener', () => {
      build({ INFERENCE_REDIS_URL: 'redis://x:6379' });
      expect(redisInstances[0].on).toHaveBeenCalledWith('error', expect.any(Function));
    });
  });

  describe('storage factory key namespace', () => {
    const build = (values: Record<string, unknown>) => {
      const redis = { defineCommand: jest.fn() };
      factoryFor(RedisThrottlerStorage).useFactory(redis, cfg(values));
      return redis;
    };

    // The default MUST match src/queues/queues.module.ts. If the two drift,
    // staging throttle buckets silently merge into prod's.
    it("defaults to 'bull', the same literal queues.module.ts uses", () => {
      const redis = { defineCommand: jest.fn() };
      const storage = factoryFor(RedisThrottlerStorage).useFactory(
        redis,
        cfg({}),
      ) as RedisThrottlerStorage;
      expect(storage['keyPrefix']).toBe('bull:throttle:');
    });

    it('honours BULLMQ_PREFIX so staging stays off prod keys', () => {
      const redis = { defineCommand: jest.fn() };
      const storage = factoryFor(RedisThrottlerStorage).useFactory(
        redis,
        cfg({ BULLMQ_PREFIX: 'bull-stg' }),
      ) as RedisThrottlerStorage;
      expect(storage['keyPrefix']).toBe('bull-stg:throttle:');
    });

    it('produces a storage instance', () => {
      build({});
      expect(
        factoryFor(RedisThrottlerStorage).useFactory({ defineCommand: jest.fn() }, cfg({})),
      ).toBeInstanceOf(RedisThrottlerStorage);
    });
  });
});
