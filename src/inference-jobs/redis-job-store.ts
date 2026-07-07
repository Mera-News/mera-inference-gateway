import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import {
  CreateJobInput,
  JobPayloadTooLargeError,
  JobResult,
  JobStatus,
  JobStore,
  RequestContext,
  ResultsView,
} from './job-store.port';

export interface RedisJobStoreOptions {
  /** Namespace for every key, e.g. `inf:` (prod) / `inf:stg:` (staging). */
  keyPrefix: string;
  /** TTL for the job hash + results hash — the client re-fetch window. */
  resultTtlSeconds: number;
  /** TTL for request bodies — only needed while workers are processing. */
  bodyTtlSeconds: number;
  /** Submit-time cap on the serialized job payload. */
  maxJobBytes: number;
}

/**
 * Redis lives on the dedicated inference-redis Memorystore instance
 * (volatile-ttl): every key written here MUST carry a TTL, both for cleanup
 * (this replaces the Mongo TTL index) and because eviction order depends on it.
 *
 * Key layout per job (24-hex id minted from crypto.randomBytes):
 *   {prefix}job:{id}          HASH   metadata + status + completedCount
 *   {prefix}job:{id}:req:{i}  STRING JSON {id, body} (E2EE ciphertext)
 *   {prefix}job:{id}:results  HASH   field {i} -> JSON {id, ok, response, error}
 *
 * All request-path reads are exact-key point lookups — no SCAN, and the
 * prefix is applied server-side only, never derived from client input.
 */
export class RedisJobStore implements JobStore {
  private readonly logger = new Logger(RedisJobStore.name);

  constructor(
    private readonly redis: Redis,
    private readonly opts: RedisJobStoreOptions,
  ) {
    // Idempotent result append: HSETNX makes BullMQ at-least-once retries
    // no-ops, and status only ever moves pending -> processing here so a
    // late duplicate can never regress a completed job.
    this.redis.defineCommand('appendJobResult', {
      numberOfKeys: 2,
      lua: `
        if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
        if redis.call('HSETNX', KEYS[2], ARGV[1], ARGV[2]) == 1 then
          redis.call('EXPIRE', KEYS[2], ARGV[3])
          redis.call('HINCRBY', KEYS[1], 'completedCount', 1)
        end
        if redis.call('HGET', KEYS[1], 'status') == 'pending' then
          redis.call('HSET', KEYS[1], 'status', 'processing')
        end
        return tonumber(redis.call('HGET', KEYS[1], 'completedCount'))
      `,
    });

    this.redis.defineCommand('finalizeJob', {
      numberOfKeys: 2,
      lua: `
        if redis.call('EXISTS', KEYS[1]) == 0 then return nil end
        redis.call('HSET', KEYS[1], 'status', 'completed', 'completedAt', ARGV[1])
        return {redis.call('HGET', KEYS[1], 'requestCount'), redis.call('HLEN', KEYS[2])}
      `,
    });
  }

  private jobKey(id: string): string {
    return `${this.opts.keyPrefix}job:${id}`;
  }

  private reqKey(id: string, index: number): string {
    return `${this.jobKey(id)}:req:${index}`;
  }

  private resultsKey(id: string): string {
    return `${this.jobKey(id)}:results`;
  }

  async createJob(input: CreateJobInput): Promise<string> {
    const serializedRequests = input.requests.map((r) =>
      JSON.stringify({ id: r.id, body: r.body }),
    );

    const bytes =
      serializedRequests.reduce((sum, s) => sum + Buffer.byteLength(s), 0) +
      (input.sharedSystem ? Buffer.byteLength(input.sharedSystem) : 0);
    if (bytes > this.opts.maxJobBytes) {
      throw new JobPayloadTooLargeError(bytes, this.opts.maxJobBytes);
    }

    // 24-hex so the id is shaped like the Mongo ObjectIds the client already
    // handles (and passes the controller's format validation).
    const id = randomBytes(12).toString('hex');
    const jobKey = this.jobKey(id);

    const hash: Record<string, string> = {
      userId: input.userId,
      status: 'pending',
      requestCount: String(input.requests.length),
      completedCount: '0',
      createdAt: new Date().toISOString(),
    };
    if (input.expoPushToken) hash.expoPushToken = input.expoPushToken;
    if (input.e2eeSession) hash.e2eeSession = JSON.stringify(input.e2eeSession);
    if (input.sharedSystem) hash.sharedSystem = input.sharedSystem;

    const pipeline = this.redis.pipeline();
    pipeline.hset(jobKey, hash);
    pipeline.expire(jobKey, this.opts.resultTtlSeconds);
    serializedRequests.forEach((json, i) => {
      pipeline.set(this.reqKey(id, i), json, 'EX', this.opts.bodyTtlSeconds);
    });
    assertPipelineOk(await pipeline.exec());

    return id;
  }

  async getRequestContext(jobId: string, requestIndex: number): Promise<RequestContext | null> {
    const pipeline = this.redis.pipeline();
    pipeline.get(this.reqKey(jobId, requestIndex));
    pipeline.hmget(this.jobKey(jobId), 'sharedSystem', 'e2eeSession');
    const replies = assertPipelineOk(await pipeline.exec());

    const requestJson = replies[0] as string | null;
    if (!requestJson) return null;
    const [sharedSystem, e2eeSessionJson] = replies[1] as (string | null)[];

    return {
      request: JSON.parse(requestJson) as RequestContext['request'],
      sharedSystem: sharedSystem ?? null,
      e2eeSession: e2eeSessionJson ? (JSON.parse(e2eeSessionJson) as Record<string, string>) : null,
    };
  }

  async appendResult(jobId: string, requestIndex: number, result: JobResult): Promise<void> {
    const json = JSON.stringify({
      id: result.id,
      ok: result.ok,
      response: result.response ?? null,
      error: result.error ?? null,
    });

    const reply = await this.redis.appendJobResult(
      this.jobKey(jobId),
      this.resultsKey(jobId),
      String(requestIndex),
      json,
      String(this.opts.resultTtlSeconds),
    );

    // Job hash already expired/evicted — same no-op semantics as the Mongo
    // adapter's updateOne matching zero docs. Log for ops visibility.
    if (reply === -1) {
      this.logger.warn(`jobId=${jobId} gone before result at index ${requestIndex} was recorded`);
    }
  }

  async finalizeJob(jobId: string): Promise<{ requestCount: number; resultCount: number } | null> {
    const reply = await this.redis.finalizeJob(
      this.jobKey(jobId),
      this.resultsKey(jobId),
      new Date().toISOString(),
    );
    if (!reply) return null;
    const [requestCount, resultCount] = reply;
    return { requestCount: Number(requestCount), resultCount: Number(resultCount) };
  }

  async getResultsView(jobId: string): Promise<ResultsView | null> {
    const pipeline = this.redis.pipeline();
    pipeline.hmget(this.jobKey(jobId), 'userId', 'status', 'requestCount');
    pipeline.hgetall(this.resultsKey(jobId));
    const replies = assertPipelineOk(await pipeline.exec());

    const [userId, status, requestCount] = replies[0] as (string | null)[];
    if (!userId || !status) return null;

    const rawResults = replies[1] as Record<string, string>;
    const results: JobResult[] = [];
    for (let i = 0; i < Number(requestCount ?? 0); i++) {
      const json = rawResults[String(i)];
      if (json) results.push(JSON.parse(json) as JobResult);
    }

    return { userId, status: status as JobStatus, results };
  }

  async getNotifyInfo(jobId: string): Promise<{ expoPushToken: string | null } | null> {
    const [userId, expoPushToken] = await this.redis.hmget(
      this.jobKey(jobId),
      'userId',
      'expoPushToken',
    );
    if (!userId) return null;
    return { expoPushToken: expoPushToken ?? null };
  }

  async ping(): Promise<void> {
    await this.redis.ping();
  }
}

/**
 * ioredis pipelines resolve even when individual commands errored; surface
 * the first command error instead of silently reading a partial write.
 */
function assertPipelineOk(replies: [Error | null, unknown][] | null): unknown[] {
  if (!replies) throw new Error('redis pipeline returned no replies');
  return replies.map(([err, value]) => {
    if (err) throw err;
    return value;
  });
}

declare module 'ioredis' {
  interface RedisCommander {
    appendJobResult(
      jobKey: string,
      resultsKey: string,
      index: string,
      resultJson: string,
      ttlSeconds: string,
    ): Promise<number>;
    finalizeJob(
      jobKey: string,
      resultsKey: string,
      completedAt: string,
    ): Promise<[string, number] | null>;
  }
}
