import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { ThrottlerStorage } from '@nestjs/throttler';

/** `ThrottlerStorageRecord` is not re-exported from the package index, so
 *  derive it from the one interface that is. Stays correct across upgrades. */
type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

interface RedisWithThrottleIncr extends Redis {
  throttleIncr(key: string, ttlMs: number): Promise<[number, number]>;
}

/**
 * Redis-backed ThrottlerStorage, so rate limits hold across autoscaled
 * instances. The stock ThrottlerStorageService is a per-process Map, which at
 * N instances makes the effective limit N x THROTTLE_LIMIT and drifts as
 * instances come and go.
 *
 * ── UNITS (easy to get backwards, and silent when you do) ──────────────────
 * `increment` RECEIVES ttl and blockDuration in MILLISECONDS but must RETURN
 * timeToExpire / timeToBlockExpire in SECONDS. That asymmetry is the stock
 * service's behaviour (getExpirationTime does Math.ceil(ms / 1000)) and it
 * feeds the X-RateLimit-Reset and Retry-After headers.
 *
 * ── blockDuration IS DELIBERATELY IGNORED ──────────────────────────────────
 * ThrottlerGuard computes `blockDuration = routeOrClass || throttler.
 * blockDuration || ttl`. Nothing in this repo sets it at any level, so it
 * always equals ttl, and a plain fixed window with `isBlocked = hits > limit`
 * is behaviourally identical. If anyone ever sets blockDuration, THIS ADAPTER
 * WILL SILENTLY IGNORE IT and they must implement a separate block key here.
 *
 * ── FAILS OPEN ─────────────────────────────────────────────────────────────
 * If Redis is unreachable OR SLOW, requests are allowed rather than rejected.
 * The slow case is the one that matters under a burst, so the client is
 * configured with a commandTimeout and no offline queue (see throttling.
 * module.ts); a try/catch alone would let every request stall behind Redis.
 */
export class RedisThrottlerStorage implements ThrottlerStorage, OnApplicationShutdown {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  /** Health of the Redis dependency. Logged on TRANSITION in both directions:
   *  a one-shot latch would tell us it broke and never that it recovered. */
  private degraded = false;

  constructor(
    private readonly redis: Redis,
    /** e.g. `bull:throttle:` (prod) / `bull-stg:throttle:` (staging). */
    private readonly keyPrefix: string,
  ) {
    // One atomic round trip. INCR creates the counter, PEXPIRE stamps the
    // window only on the first hit of that window (so a busy key's window is
    // never extended), PTTL reports what is left for the response headers.
    this.redis.defineCommand('throttleIncr', {
      numberOfKeys: 1,
      lua: `
        local hits = redis.call('INCR', KEYS[1])
        if hits == 1 then
          redis.call('PEXPIRE', KEYS[1], ARGV[1])
        end
        return {hits, redis.call('PTTL', KEYS[1])}
      `,
    });
  }

  // NOTE the arity: ThrottlerStorage declares increment(key, ttl, limit,
  // blockDuration, throttlerName), and this takes only the first three.
  // TypeScript accepts the narrower signature, and the two omitted arguments
  // are exactly the ones this adapter does not honour -- blockDuration for the
  // reason in the class comment, throttlerName because the guard has already
  // folded it into `key` via generateKey(). Omitting beats accepting and
  // ignoring: the compiler now stops anyone assuming they take effect.
  async increment(key: string, ttl: number, limit: number): Promise<ThrottlerStorageRecord> {
    // ConfigService.get<number> does not coerce, so these can arrive as
    // strings from env. Normalise before any arithmetic or comparison.
    const ttlMs = Number(ttl);
    const limitValue = Number(limit);

    try {
      const [hits, pttl] = await (this.redis as RedisWithThrottleIncr).throttleIncr(
        `${this.keyPrefix}${key}`,
        ttlMs,
      );
      this.markHealthy();

      // PTTL returns -1 (no expiry) / -2 (no key) in races; fall back to the
      // full window rather than reporting a negative reset time.
      const timeToExpire = Math.ceil((pttl > 0 ? pttl : ttlMs) / 1000);
      const isBlocked = hits > limitValue;

      return {
        totalHits: hits,
        timeToExpire,
        isBlocked,
        timeToBlockExpire: isBlocked ? timeToExpire : 0,
      };
    } catch (error) {
      this.markDegraded(error);
      // Fail OPEN: allow the request.
      return {
        totalHits: 0,
        timeToExpire: Math.ceil(ttlMs / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }

  private markDegraded(error: unknown): void {
    if (this.degraded) return;
    this.degraded = true;
    this.logger.warn(
      `Throttle store unreachable, failing OPEN (rate limits not enforced): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  private markHealthy(): void {
    if (!this.degraded) return;
    this.degraded = false;
    this.logger.log('Throttle store recovered, rate limits enforced again');
  }
}
