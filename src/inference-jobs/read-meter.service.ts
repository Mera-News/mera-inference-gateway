import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Tier, TIER_MULTIPLIER } from '../auth/tier';
import { JOB_STORE_REDIS_CLIENT } from './job-store.module';

export const METER_TTL_SECONDS = 172_800;

export type MeterCharge = { key: string; bytes: number };

export type ChargeResult =
  | { status: 'off' }
  | { status: 'charged'; charge: MeterCharge; used: number; limit: number }
  | { status: 'refused'; used: number; limit: number; resetAt: Date; nowMs: number };

type MeterRedis = Redis & {
  chargeReadMeter(
    key: string,
    indexKey: string,
    cost: number,
    cand: number,
    nowMs: number,
    userId: string,
    ttl: number,
  ): Promise<[number, number, number]>;
  refundReadMeter(key: string, bytes: number, ttl: number): Promise<number>;
};

/**
 * Per-user daily read-byte meter on the job-store Redis. One hash per user
 * per UTC day: bytes, calls, limit, limitHitAt. A second set per day indexes
 * the users seen.
 *
 * Fail-open cases, all accepted: volatile-ttl eviction of a meter hash resets
 * that day's count; follow-ups (mayRaiseLimit=false) never raise the stored
 * limit; a missing hash means 1x.
 */
@Injectable()
export class ReadMeterService implements OnModuleInit {
  private readonly logger = new Logger(ReadMeterService.name);
  enabled = false;
  private base = 0;
  private prefix = 'inf:';

  constructor(
    @Inject(JOB_STORE_REDIS_CLIENT) private readonly redis: Redis,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const raw = this.config.get<string>('READ_BUDGET_BASE_BYTES');
    if (raw === undefined || raw === '') {
      this.logger.warn('READ_BUDGET_BASE_BYTES is unset: read meter is OFF');
      return;
    }
    const base = Number(raw);
    if (!Number.isInteger(base) || base <= 0) {
      throw new Error(`READ_BUDGET_BASE_BYTES must be a positive integer, got "${raw}"`);
    }
    const maxJob = Number(this.config.get('INFERENCE_MAX_JOB_BYTES') ?? 5_242_880);
    if (base < maxJob) {
      throw new Error(
        `READ_BUDGET_BASE_BYTES (${base}) must be >= INFERENCE_MAX_JOB_BYTES (${maxJob})`,
      );
    }
    this.base = base;
    this.prefix = this.config.get<string>('INFERENCE_JOBS_KEY_PREFIX') ?? 'inf:';
    this.redis.defineCommand('chargeReadMeter', {
      numberOfKeys: 2,
      lua: `
        local stored = tonumber(redis.call('HGET', KEYS[1], 'limit') or '')
        local cand = tonumber(ARGV[2]); local limit = stored
        if stored == nil or cand > stored then
          redis.call('HSET', KEYS[1], 'limit', ARGV[2])
          if stored ~= nil then redis.call('HDEL', KEYS[1], 'limitHitAt') end
          limit = cand
        end
        local used = tonumber(redis.call('HGET', KEYS[1], 'bytes') or '0')
        redis.call('SADD', KEYS[2], ARGV[4]); redis.call('EXPIRE', KEYS[2], ARGV[5])
        if used + tonumber(ARGV[1]) > limit then
          redis.call('HSETNX', KEYS[1], 'limitHitAt', ARGV[3]); redis.call('EXPIRE', KEYS[1], ARGV[5])
          return {0, used, limit}
        end
        used = redis.call('HINCRBY', KEYS[1], 'bytes', ARGV[1]); redis.call('HINCRBY', KEYS[1], 'calls', 1)
        redis.call('EXPIRE', KEYS[1], ARGV[5]); return {1, used, limit}
      `,
    });
    this.redis.defineCommand('refundReadMeter', {
      numberOfKeys: 1,
      lua: `
        if redis.call('EXISTS', KEYS[1]) == 1 then
          redis.call('HINCRBY', KEYS[1], 'bytes', -tonumber(ARGV[1]))
          redis.call('HINCRBY', KEYS[1], 'calls', -1)
          redis.call('EXPIRE', KEYS[1], ARGV[2])
        end
        return 1
      `,
    });
    this.enabled = true;
  }

  async charge(args: {
    userId: string;
    tier: Tier | undefined;
    cost: number;
    mayRaiseLimit: boolean;
  }): Promise<ChargeResult> {
    if (!this.enabled) return { status: 'off' };
    const r = this.redis as MeterRedis;
    const [sec, usec] = await r.time();
    const nowMs = Number(sec) * 1000 + Math.floor(Number(usec) / 1000);
    const d = new Date(nowMs);
    const day = d.toISOString().slice(0, 10).replace(/-/g, '');
    const resetAt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
    const key = `${this.prefix}meter:${args.userId}:${day}`;
    const indexKey = `${this.prefix}meter:users:${day}`;
    const cand = args.mayRaiseLimit
      ? this.base * TIER_MULTIPLIER[args.tier ?? 'starter']
      : this.base;
    const [ok, used, limit] = await r.chargeReadMeter(
      key,
      indexKey,
      args.cost,
      cand,
      nowMs,
      args.userId,
      METER_TTL_SECONDS,
    );
    return ok === 1
      ? { status: 'charged', charge: { key, bytes: args.cost }, used, limit }
      : { status: 'refused', used, limit, resetAt, nowMs };
  }

  async refund(charge: MeterCharge): Promise<void> {
    try {
      await (this.redis as MeterRedis).refundReadMeter(charge.key, charge.bytes, METER_TTL_SECONDS);
    } catch (err) {
      this.logger.warn(`read meter refund failed: ${(err as Error).message}`);
    }
  }
}
