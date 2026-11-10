import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { PROVIDERS, type Provider } from '../constants';
import { LANES, PROFILES, profileFor } from './profiles';

export const ROUTING_PROBE_QUEUE = 'routing-probe';
export const PROBE_EVERY_MS = 60_000;
/** Hysteresis: consecutive failed probes to go down, passing probes to come back. */
export const FAILS_TO_DOWN = 2;
export const PASSES_TO_UP = 3;
/** Snapshot reuse window; bounds Redis reads (every response asks for the version). */
const SNAPSHOT_TTL_MS = 3_000;

type Up = 'up' | 'down';
export type LaneState = 'ok' | 'degraded' | 'down';

export interface RoutingBody {
  version: number;
  updatedAt: string;
  lanes: Record<string, { state: LaneState; profiles: string[] }>;
}

interface Snapshot {
  version: number;
  updatedAt: string;
  effective: Record<string, Up>;
  at: number;
}

interface Health {
  state: Up;
  fails: number;
  passes: number;
}

@Injectable()
export class RoutingService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RoutingService.name);
  private readonly prefix: string;
  private snapshotCache: Snapshot | null = null;

  constructor(
    private readonly config: ConfigService,
    @InjectQueue(ROUTING_PROBE_QUEUE) private readonly queue: Queue,
  ) {
    // Same default literal as queues.module.ts and throttling.module.ts.
    this.prefix = `${this.config.get<string>('BULLMQ_PREFIX', 'bull')}:routing-table`;
  }

  /** One scheduler per profile; upserting is idempotent across instances. */
  async onApplicationBootstrap(): Promise<void> {
    if (this.config.get<string>('ROUTING_PROBES_ENABLED', 'true') === 'false') return;
    for (const profile of Object.keys(PROFILES)) {
      try {
        await this.queue.upsertJobScheduler(
          `probe:${profile}`,
          { every: PROBE_EVERY_MS },
          { name: 'probe', data: { profile }, opts: this.probeJobOpts() },
        );
      } catch (err) {
        this.logger.error(`probe scheduler failed profile=${profile}: ${(err as Error).message}`);
      }
    }
  }

  keyFor(provider: Provider): string {
    return this.config.get<string>(PROVIDERS[provider].keyEnv, '') ?? '';
  }

  /** True when the (provider, model) pair is a known profile that is marked down. */
  async isDown(provider: Provider, model: string): Promise<boolean> {
    const id = profileFor(provider, model);
    if (!id) return false;
    return (await this.snapshot()).effective[id] === 'down';
  }

  /** True when a submit has nothing to run on: no key for the provider, or every
   *  model it names is marked down. A mixed set still runs; the down items fail alone. */
  async allDown(provider: Provider, models: string[]): Promise<boolean> {
    if (!this.keyFor(provider)) return true;
    if (models.length === 0) return false;
    const downs = await Promise.all(models.map((m) => this.isDown(provider, m)));
    return downs.every(Boolean);
  }

  /** Same answer from the cached table, no I/O: for the proxy hot path, where the
   *  request's own header stamp has just refreshed the cache. Unknown reads as up. */
  isDownCached(provider: Provider, model: string): boolean {
    const id = profileFor(provider, model);
    return !!id && this.snapshotCache?.effective[id] === 'down';
  }

  async version(): Promise<number> {
    return (await this.snapshot()).version;
  }

  async body(): Promise<RoutingBody> {
    const snap = await this.snapshot();
    const lanes: RoutingBody['lanes'] = {};
    for (const [lane, ranking] of Object.entries(LANES)) {
      const profiles = ranking.filter((id) => snap.effective[id] !== 'down');
      const state: LaneState =
        profiles[0] === ranking[0] ? 'ok' : profiles.length > 0 ? 'degraded' : 'down';
      lanes[lane] = { state, profiles };
    }
    return { version: snap.version, updatedAt: snap.updatedAt, lanes };
  }

  /** The 503 body for a request whose (provider, model) is down. */
  async unavailableBody() {
    return {
      error: { code: 'model_unavailable', message: 'This model is paused. Try another one.' },
      routing: await this.body(),
    };
  }

  /** A real request failed in a model-class way: probe now instead of waiting for the tick. */
  reportFailure(provider: Provider, model: string): void {
    const profile = profileFor(provider, model);
    if (!profile) return;
    // The fixed jobId collapses a burst of failures into one queued probe.
    this.queue
      .add('probe', { profile }, { jobId: `suspect:${profile}`, ...this.probeJobOpts() })
      .catch((err: Error) => this.logger.error(`suspect probe not queued: ${err.message}`));
  }

  /**
   * Fold one probe result into the profile's health. Read-modify-write without
   * a lock: a profile's probes run one at a time except an immediate probe that
   * can overlap a tick, which at worst counts one probe twice.
   */
  async recordProbe(profile: string, ok: boolean): Promise<void> {
    const redis = await this.redis();
    const raw = await redis.hget(this.key('health'), profile);
    const h: Health = raw ? (JSON.parse(raw) as Health) : { state: 'up', fails: 0, passes: 0 };
    const pin = await this.pinOf(redis, profile);
    const before = pin ?? h.state;
    if (ok) {
      h.passes += 1;
      h.fails = 0;
      if (h.state === 'down' && h.passes >= PASSES_TO_UP) h.state = 'up';
    } else {
      h.fails += 1;
      h.passes = 0;
      if (h.state === 'up' && h.fails >= FAILS_TO_DOWN) h.state = 'down';
    }
    await redis.hset(this.key('health'), profile, JSON.stringify(h));
    await this.changed(redis, profile, before, pin ?? h.state);
  }

  async setPin(profile: string, state: Up | 'auto'): Promise<void> {
    const redis = await this.redis();
    const raw = await redis.hget(this.key('health'), profile);
    const health: Up = raw ? (JSON.parse(raw) as Health).state : 'up';
    const before = (await this.pinOf(redis, profile)) ?? health;
    if (state === 'auto') await redis.hdel(this.key('pins'), profile);
    else await redis.hset(this.key('pins'), profile, state);
    await this.changed(redis, profile, before, state === 'auto' ? health : state);
  }

  private async changed(redis: Redis, profile: string, from: Up, to: Up): Promise<void> {
    if (from === to) return;
    await redis.hincrby(this.key('meta'), 'version', 1);
    await redis.hset(this.key('meta'), 'updatedAt', new Date().toISOString());
    this.snapshotCache = null;
    // error level on purpose: prod's LOG_LEVEL drops anything quieter, and
    // alerts key off these exact lines. Content-free by construction.
    this.logger.error(`routing_state_change profile=${profile} from=${from} to=${to}`);
    const snap = await this.snapshot();
    if (Object.values(snap.effective).every((s) => s === 'down')) {
      this.logger.error('routing_all_down');
    }
  }

  private async pinOf(redis: Redis, profile: string): Promise<Up | null> {
    const pin = await redis.hget(this.key('pins'), profile);
    return pin === 'up' || pin === 'down' ? pin : null;
  }

  /** Never throws: Redis down serves the last known table, else every profile up. */
  private async snapshot(): Promise<Snapshot> {
    const cached = this.snapshotCache;
    if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached;
    try {
      const redis = await this.redis();
      const [health, pins, meta] = await Promise.all([
        redis.hgetall(this.key('health')),
        redis.hgetall(this.key('pins')),
        redis.hgetall(this.key('meta')),
      ]);
      const effective: Record<string, Up> = {};
      for (const [id, profile] of Object.entries(PROFILES)) {
        const state: Up = health[id] ? (JSON.parse(health[id]) as Health).state : 'up';
        const pin = pins[id] === 'up' || pins[id] === 'down' ? pins[id] : null;
        // An unset provider key is down: there is nothing to call it with.
        effective[id] = !this.keyFor(profile.provider) ? 'down' : (pin ?? state);
      }
      this.snapshotCache = {
        version: Number(meta.version ?? 0),
        updatedAt: meta.updatedAt ?? new Date(0).toISOString(),
        effective,
        at: Date.now(),
      };
    } catch (err) {
      this.logger.error(`routing table read failed: ${(err as Error).message}`);
      this.snapshotCache ??= {
        version: 0,
        updatedAt: new Date(0).toISOString(),
        effective: Object.fromEntries(Object.keys(PROFILES).map((id) => [id, 'up'])),
        at: 0,
      };
      this.snapshotCache.at = Date.now();
    }
    return this.snapshotCache;
  }

  /** The routing table lives on the BullMQ Redis (noeviction), reusing the queue's connection. */
  private async redis(): Promise<Redis> {
    return (await this.queue.waitUntilReady()) as unknown as Redis;
  }

  private key(name: 'health' | 'pins' | 'meta'): string {
    return `${this.prefix}:${name}`;
  }

  private probeJobOpts() {
    return { attempts: 1, removeOnComplete: true, removeOnFail: { count: 20 } };
  }
}
