import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Tier } from '../auth/tier';
import { JOB_STORE_REDIS_CLIENT } from './job-store.module';

export const METER_TTL_SECONDS = 172_800;
export const MIN_READ_BUDGET_BYTES = 1_000_000;

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
 * limit; a missing hash means the Starter budget.
 *
 * Budgets are static per tier, set in infra via READ_BUDGET_STARTER_BYTES,
 * READ_BUDGET_INDIVIDUAL_BYTES and READ_BUDGET_PROFESSIONAL_BYTES (decimal
 * bytes per UTC day). mera-server reads the same three vars.
 */
@Injectable()
export class ReadMeterService implements OnModuleInit {
  private readonly logger = new Logger(ReadMeterService.name);
  enabled = false;
  private budgets = { starter: 0, individual: 0, professional: 0 };
  private prefix = 'inf:';

  constructor(
    @Inject(JOB_STORE_REDIS_CLIENT) private readonly redis: Redis,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const names = {
      starter: 'READ_BUDGET_STARTER_BYTES',
      individual: 'READ_BUDGET_INDIVIDUAL_BYTES',
      professional: 'READ_BUDGET_PROFESSIONAL_BYTES',
    } as const;
    const raws = Object.values(names).map((n) => this.config.get<string>(n));
    if (raws.every((r) => r === undefined || r === '')) {
      this.logger.warn('READ_BUDGET_*_BYTES are unset: read meter is OFF');
      return;
    }
    const parse = (name: string): number => {
      const raw = this.config.get<string>(name);
      if (raw === undefined || raw === '')
        throw new Error(`${name} must be set when any read budget is set`);
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0)
        throw new Error(`${name} must be a positive integer, got "${raw}"`);
      return n;
    };
    const starter = parse(names.starter);
    const individual = parse(names.individual);
    const professional = parse(names.professional);
    // The app sends at most 10 calls a job (~0.7 MB metered), so any real job
    // fits a 1 MB day; the job store's own INFERENCE_MAX_JOB_BYTES is far larger.
    if (starter < MIN_READ_BUDGET_BYTES) {
      throw new Error(`${names.starter} (${starter}) must be >= ${MIN_READ_BUDGET_BYTES}`);
    }
    if (individual < starter) throw new Error(`${names.individual} must be >= ${names.starter}`);
    if (professional < individual)
      throw new Error(`${names.professional} must be >= ${names.individual}`);
    this.budgets = { starter, individual, professional };
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
    // A capability follow-up offers the smallest plan; the stored limit only rises.
    const cand = args.mayRaiseLimit ? this.budgetFor(args.tier) : this.budgets.starter;
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

  private budgetFor(tier: Tier | undefined): number {
    return tier === 'individual' || tier === 'professional'
      ? this.budgets[tier]
      : this.budgets.starter;
  }

  async refund(charge: MeterCharge): Promise<void> {
    try {
      await (this.redis as MeterRedis).refundReadMeter(charge.key, charge.bytes, METER_TTL_SECONDS);
    } catch (err) {
      this.logger.warn(`read meter refund failed: ${(err as Error).message}`);
    }
  }
}
