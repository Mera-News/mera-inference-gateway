import { Logger } from '@nestjs/common';
import { RedisJobStore, RedisJobStoreOptions } from './redis-job-store';
import { JobPayloadTooLargeError } from './job-store.port';

const OPTS: RedisJobStoreOptions = {
  keyPrefix: 'inf:',
  resultTtlSeconds: 86_400,
  bodyTtlSeconds: 7_200,
  maxJobBytes: 5_242_880,
};

type PipelineCall = [string, ...unknown[]];

/**
 * Minimal ioredis stand-in: records pipeline commands, resolves each with
 * [null, value], and exposes the custom Lua commands as plain jest mocks.
 */
function makeRedisMock(pipelineReplies: unknown[] = []) {
  const calls: PipelineCall[] = [];
  const pipeline = {
    hset: jest.fn((...args: unknown[]) => calls.push(['hset', ...args])),
    expire: jest.fn((...args: unknown[]) => calls.push(['expire', ...args])),
    set: jest.fn((...args: unknown[]) => calls.push(['set', ...args])),
    get: jest.fn((...args: unknown[]) => calls.push(['get', ...args])),
    hmget: jest.fn((...args: unknown[]) => calls.push(['hmget', ...args])),
    hgetall: jest.fn((...args: unknown[]) => calls.push(['hgetall', ...args])),
    exec: jest
      .fn<Promise<[Error | null, unknown][]>, []>()
      .mockImplementation(async () =>
        calls.map((_, i) => [null, pipelineReplies[i] ?? null] as [Error | null, unknown]),
      ),
  };
  return {
    calls,
    pipeline: jest.fn(() => pipeline),
    defineCommand: jest.fn(),
    appendJobResult: jest.fn().mockResolvedValue(1),
    finalizeJob: jest.fn(),
    hmget: jest.fn(),
    ping: jest.fn().mockResolvedValue('PONG'),
    _pipelineObj: pipeline,
  };
}

const BASE_INPUT = {
  userId: 'user-1',
  expoPushToken: 'ExponentPushToken[t]',
  e2eeSession: { 'X-Signing-Algo': 'ed' },
  requests: [
    { id: 'a', body: { x: 1 } },
    { id: 'b', body: {} },
  ],
  sharedSystem: 'CIPHER',
};

describe('RedisJobStore', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('constructor', () => {
    it('registers both Lua commands', () => {
      const redis = makeRedisMock();
      new RedisJobStore(redis as never, OPTS);
      const names = redis.defineCommand.mock.calls.map((c) => c[0] as string);
      expect(names).toEqual(expect.arrayContaining(['appendJobResult', 'finalizeJob']));
    });
  });

  describe('createJob', () => {
    it('returns a 24-hex id and writes hash + per-request keys with TTLs', async () => {
      const redis = makeRedisMock();
      const store = new RedisJobStore(redis as never, OPTS);

      const id = await store.createJob(BASE_INPUT);

      expect(id).toMatch(/^[0-9a-f]{24}$/);

      const [hsetCall, expireCall, set0, set1] = redis.calls;
      expect(hsetCall[0]).toBe('hset');
      expect(hsetCall[1]).toBe(`inf:job:${id}`);
      expect(hsetCall[2]).toMatchObject({
        userId: 'user-1',
        status: 'pending',
        requestCount: '2',
        completedCount: '0',
        expoPushToken: 'ExponentPushToken[t]',
        e2eeSession: JSON.stringify({ 'X-Signing-Algo': 'ed' }),
        sharedSystem: 'CIPHER',
      });

      expect(expireCall).toEqual(['expire', `inf:job:${id}`, 86_400]);
      expect(set0).toEqual([
        'set',
        `inf:job:${id}:req:0`,
        JSON.stringify({ id: 'a', body: { x: 1 } }),
        'EX',
        7_200,
      ]);
      expect(set1[1]).toBe(`inf:job:${id}:req:1`);
    });

    it('omits optional hash fields when they are null', async () => {
      const redis = makeRedisMock();
      const store = new RedisJobStore(redis as never, OPTS);

      await store.createJob({
        ...BASE_INPUT,
        expoPushToken: null,
        e2eeSession: null,
        sharedSystem: null,
      });

      const hash = redis.calls[0][2] as Record<string, string>;
      expect(hash).not.toHaveProperty('expoPushToken');
      expect(hash).not.toHaveProperty('e2eeSession');
      expect(hash).not.toHaveProperty('sharedSystem');
    });

    it('mints a fresh id per job', async () => {
      const redis = makeRedisMock();
      const store = new RedisJobStore(redis as never, OPTS);
      const a = await store.createJob(BASE_INPUT);
      const b = await store.createJob(BASE_INPUT);
      expect(a).not.toBe(b);
    });

    it('throws JobPayloadTooLargeError above the byte cap without touching redis', async () => {
      const redis = makeRedisMock();
      const store = new RedisJobStore(redis as never, { ...OPTS, maxJobBytes: 10 });

      await expect(store.createJob(BASE_INPUT)).rejects.toThrow(JobPayloadTooLargeError);
      expect(redis.pipeline).not.toHaveBeenCalled();
    });

    it('surfaces a per-command pipeline error', async () => {
      const redis = makeRedisMock();
      redis._pipelineObj.exec.mockResolvedValue([[new Error('OOM'), null]]);
      const store = new RedisJobStore(redis as never, OPTS);

      await expect(store.createJob(BASE_INPUT)).rejects.toThrow('OOM');
    });
  });

  describe('getRequestContext', () => {
    it('parses the request and job-level context', async () => {
      const reqJson = JSON.stringify({ id: 'a', body: { x: 1 } });
      const redis = makeRedisMock([
        reqJson,
        ['CIPHER', JSON.stringify({ 'X-Client-Pub-Key': 'k' })],
      ]);
      const store = new RedisJobStore(redis as never, OPTS);

      const ctx = await store.getRequestContext('a'.repeat(24), 0);

      expect(ctx).toEqual({
        request: { id: 'a', body: { x: 1 } },
        sharedSystem: 'CIPHER',
        e2eeSession: { 'X-Client-Pub-Key': 'k' },
      });
      expect(redis.calls[0]).toEqual(['get', `inf:job:${'a'.repeat(24)}:req:0`]);
    });

    it('returns null when the request key is missing/expired', async () => {
      const redis = makeRedisMock([null, [null, null]]);
      const store = new RedisJobStore(redis as never, OPTS);
      await expect(store.getRequestContext('a'.repeat(24), 3)).resolves.toBeNull();
    });

    it('returns nulls for absent sharedSystem / e2eeSession', async () => {
      const reqJson = JSON.stringify({ id: 'a', body: {} });
      const redis = makeRedisMock([reqJson, [null, null]]);
      const store = new RedisJobStore(redis as never, OPTS);

      const ctx = await store.getRequestContext('a'.repeat(24), 0);
      expect(ctx?.sharedSystem).toBeNull();
      expect(ctx?.e2eeSession).toBeNull();
    });
  });

  describe('appendResult', () => {
    it('invokes the Lua command with a normalized result JSON', async () => {
      const redis = makeRedisMock();
      const store = new RedisJobStore(redis as never, OPTS);
      const id = 'b'.repeat(24);

      await store.appendResult(id, 2, { id: 'r2', ok: true, response: { c: [] }, error: null });

      expect(redis.appendJobResult).toHaveBeenCalledWith(
        `inf:job:${id}`,
        `inf:job:${id}:results`,
        '2',
        JSON.stringify({ id: 'r2', ok: true, response: { c: [] }, error: null }),
        '86400',
      );
    });

    it('serializes missing response/error as explicit nulls', async () => {
      const redis = makeRedisMock();
      const store = new RedisJobStore(redis as never, OPTS);

      await store.appendResult('b'.repeat(24), 0, {
        id: 'r0',
        ok: false,
        response: undefined as never,
        error: 'boom',
      });

      const json = redis.appendJobResult.mock.calls[0][3] as string;
      expect(JSON.parse(json)).toEqual({ id: 'r0', ok: false, response: null, error: 'boom' });
    });

    it('logs a warning (no throw) when the job hash is gone', async () => {
      const redis = makeRedisMock();
      redis.appendJobResult.mockResolvedValue(-1);
      const store = new RedisJobStore(redis as never, OPTS);

      await expect(
        store.appendResult('b'.repeat(24), 0, { id: 'r0', ok: true, response: {}, error: null }),
      ).resolves.toBeUndefined();
      expect(Logger.prototype.warn).toHaveBeenCalled();
    });
  });

  describe('finalizeJob', () => {
    it('returns counts from the Lua reply', async () => {
      const redis = makeRedisMock();
      redis.finalizeJob.mockResolvedValue(['3', 3]);
      const store = new RedisJobStore(redis as never, OPTS);

      await expect(store.finalizeJob('c'.repeat(24))).resolves.toEqual({
        requestCount: 3,
        resultCount: 3,
      });
    });

    it('returns null for an unknown job', async () => {
      const redis = makeRedisMock();
      redis.finalizeJob.mockResolvedValue(null);
      const store = new RedisJobStore(redis as never, OPTS);
      await expect(store.finalizeJob('c'.repeat(24))).resolves.toBeNull();
    });
  });

  describe('getResultsView', () => {
    it('always carries userId and orders results by request index', async () => {
      const redis = makeRedisMock([
        ['user-1', 'completed', '3'],
        {
          '2': JSON.stringify({ id: 'r2', ok: true, response: 2, error: null }),
          '0': JSON.stringify({ id: 'r0', ok: true, response: 0, error: null }),
          '1': JSON.stringify({ id: 'r1', ok: false, response: null, error: 'x' }),
        },
      ]);
      const store = new RedisJobStore(redis as never, OPTS);

      const view = await store.getResultsView('d'.repeat(24));

      expect(view?.userId).toBe('user-1');
      expect(view?.status).toBe('completed');
      expect(view?.results.map((r) => r.id)).toEqual(['r0', 'r1', 'r2']);
      expect(view?.results[1]).toEqual({ id: 'r1', ok: false, response: null, error: 'x' });
    });

    it('returns null when the job hash is missing', async () => {
      const redis = makeRedisMock([[null, null, null], {}]);
      const store = new RedisJobStore(redis as never, OPTS);
      await expect(store.getResultsView('d'.repeat(24))).resolves.toBeNull();
    });

    it('skips holes for a partially-processed job', async () => {
      const redis = makeRedisMock([
        ['user-1', 'processing', '3'],
        { '1': JSON.stringify({ id: 'r1', ok: true, response: 1, error: null }) },
      ]);
      const store = new RedisJobStore(redis as never, OPTS);

      const view = await store.getResultsView('d'.repeat(24));
      expect(view?.status).toBe('processing');
      expect(view?.results).toHaveLength(1);
    });
  });

  describe('getNotifyInfo', () => {
    it('returns the push token for a known job', async () => {
      const redis = makeRedisMock();
      redis.hmget.mockResolvedValue(['user-1', 'ExponentPushToken[x]']);
      const store = new RedisJobStore(redis as never, OPTS);

      await expect(store.getNotifyInfo('e'.repeat(24))).resolves.toEqual({
        expoPushToken: 'ExponentPushToken[x]',
      });
    });

    it('returns { expoPushToken: null } for a tokenless job', async () => {
      const redis = makeRedisMock();
      redis.hmget.mockResolvedValue(['user-1', null]);
      const store = new RedisJobStore(redis as never, OPTS);

      await expect(store.getNotifyInfo('e'.repeat(24))).resolves.toEqual({ expoPushToken: null });
    });

    it('returns null for an unknown job', async () => {
      const redis = makeRedisMock();
      redis.hmget.mockResolvedValue([null, null]);
      const store = new RedisJobStore(redis as never, OPTS);
      await expect(store.getNotifyInfo('e'.repeat(24))).resolves.toBeNull();
    });
  });

  describe('ping', () => {
    it('resolves when redis responds', async () => {
      const redis = makeRedisMock();
      const store = new RedisJobStore(redis as never, OPTS);
      await expect(store.ping()).resolves.toBeUndefined();
    });

    it('rejects when redis is unreachable', async () => {
      const redis = makeRedisMock();
      redis.ping.mockRejectedValue(new Error('ECONNREFUSED'));
      const store = new RedisJobStore(redis as never, OPTS);
      await expect(store.ping()).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('key prefixing', () => {
    it('applies the configured prefix to every key', async () => {
      const redis = makeRedisMock();
      const store = new RedisJobStore(redis as never, { ...OPTS, keyPrefix: 'inf:stg:' });
      const id = await store.createJob(BASE_INPUT);
      expect(redis.calls[0][1]).toBe(`inf:stg:job:${id}`);
    });
  });
});
