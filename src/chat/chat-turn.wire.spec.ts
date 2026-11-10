import { INestApplication, Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import http from 'http';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import type { AddressInfo } from 'net';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { JOB_STORE } from '../inference-jobs/job-store.port';
import { ReadMeterService } from '../inference-jobs/read-meter.service';
import { RedisJobStore } from '../inference-jobs/redis-job-store';
import { RoutingService } from '../routing/routing.service';
import { ChatService } from './chat.service';
import { ChatTurnService } from './chat-turn.service';
import { CompletionsController } from './completions.controller';
import { InferenceQueueService } from './inference-queue.service';

/**
 * The detached turn over real HTTP: NEAR faked at `fetch`, Redis in memory
 * (`ioredis-mock` clients share one dataset, so two apps are two instances).
 */

const TURN = 'turn-0123456789abcdef';
const KEY = `inf:turn:${TURN}`;

function fakeUpstream(contentType = 'text/event-stream', status = 200) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let onCancel!: () => void;
  const cancelled = new Promise<void>((r) => (onCancel = r));
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
      cancel: () => onCancel(),
    }),
    { status, headers: { 'content-type': contentType, 'x-model-pub-key': 'abcd' } },
  );
  return {
    response,
    cancelled,
    push: (chunk: Uint8Array | string) =>
      controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : chunk),
    close: () => controller.close(),
  };
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  aborted: boolean;
}

function collect(res: http.IncomingMessage): Promise<Reply> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const done = (aborted: boolean) =>
      resolve({
        status: res.statusCode!,
        headers: res.headers,
        body: Buffer.concat(chunks),
        aborted,
      });
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('error', () => done(true));
    res.on('end', () => done(!res.complete));
  });
}

function call(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, method, path, headers }, (res) => resolve(collect(res)));
    req.on('error', reject);
    req.end();
  });
}

/** Starts a chat POST; `drop()` walks away from it the way a suspended phone does. */
function startChat(port: number, headers: Record<string, string> = { 'x-mera-turn-id': TURN }) {
  const req = http.request({
    port,
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', ...headers },
  });
  const answered = new Promise<http.IncomingMessage>((resolve, reject) => {
    req.on('response', resolve);
    req.on('error', reject);
  });
  req.end(JSON.stringify({ model: 'm', stream: true, messages: [] }));
  return {
    /** The first bytes have arrived. */
    started: answered,
    reply: answered.then(collect),
    drop: () => {
      req.on('error', () => undefined);
      req.destroy();
    },
  };
}

const until = async (check: () => Promise<boolean> | boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const ROUTING_UP = {
  keyFor: () => 'k',
  isDown: async () => false,
  isDownCached: () => false,
  reportFailure: () => undefined,
  unavailableBody: async () => ({}),
};

describe('detached chat turns on the wire', () => {
  const apps: INestApplication[] = [];
  let redis: Redis;
  let store: RedisJobStore;
  let fetchSpy: jest.SpyInstance;

  async function boot(env: Record<string, unknown> = {}) {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          isGlobal: true,
          load: [() => ({ NEAR_AI_API_KEY: 'k', CHAT_TURN_RESUME_ENABLED: 'true', ...env })],
        }),
      ],
      controllers: [CompletionsController],
      providers: [
        ChatService,
        ChatTurnService,
        { provide: RoutingService, useValue: ROUTING_UP },
        InferenceQueueService,
        { provide: JOB_STORE, useValue: store },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (ctx: { switchToHttp(): { getRequest(): AuthenticatedRequest } }) => {
          const req = ctx.switchToHttp().getRequest();
          req.user = {
            id: String(req.headers['x-test-user'] ?? 'alice'),
            subscriptionIsActive: true,
            ...(req.headers['x-test-capability'] ? { capability: { uid: 'alice' } as never } : {}),
          };
          return true;
        },
      })
      .compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    apps.push(app);
    return (app.getHttpServer().address() as AddressInfo).port;
  }

  const statusOf = (port: number, id = TURN) =>
    call(port, 'GET', `/v1/chat/turns/${id}`).then((r) => r.headers['x-mera-turn-status']);

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    fetchSpy = jest.spyOn(globalThis, 'fetch');
    redis = new RedisMock();
    await redis.flushall();
    store = new RedisJobStore(redis, {
      keyPrefix: 'inf:',
      resultTtlSeconds: 86_400,
      bodyTtlSeconds: 7_200,
      turnTtlSeconds: 3_600,
      maxJobBytes: 5_242_880,
    });
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    redis.disconnect();
    jest.restoreAllMocks();
  });

  it('a live client gets the upstream bytes, status and headers unchanged', async () => {
    const port = await boot();
    const up = fakeUpstream();
    fetchSpy.mockResolvedValue(up.response);

    const chat = startChat(port);
    up.push('data: a\n\n');
    up.push('data: [DONE]\n\n');
    up.close();
    const res = await chat.reply;

    expect(res).toMatchObject({ status: 200, aborted: false });
    expect(res.body.toString()).toBe('data: a\n\ndata: [DONE]\n\n');
    expect(res.headers['x-model-pub-key']).toBe('abcd');
    expect(res.headers['content-type']).toBe('text/event-stream');
  });

  it('a disconnect leaves upstream running, and replay equals the original bytes', async () => {
    const port = await boot();
    const up = fakeUpstream();
    fetchSpy.mockResolvedValue(up.response);
    let cancelled = false;
    void up.cancelled.then(() => (cancelled = true));

    const chat = startChat(port);
    up.push('data: one\n\n');
    await chat.started;
    chat.drop();
    await new Promise((r) => setTimeout(r, 50));

    // Bytes that split a character prove the store is binary safe.
    const late = Buffer.from([0xff, 0x00, 0xe2, 0x82]);
    up.push(late);
    expect(await statusOf(port)).toBe('running');
    up.push('data: [DONE]\n\n');
    up.close();
    await until(async () => (await statusOf(port)) === 'done');

    expect(cancelled).toBe(false);
    const all = Buffer.concat([
      Buffer.from('data: one\n\n'),
      late,
      Buffer.from('data: [DONE]\n\n'),
    ]);
    const replay = await call(port, 'GET', `/v1/chat/turns/${TURN}`);
    expect(replay.status).toBe(200);
    expect(replay.body.equals(all)).toBe(true);
    expect(replay.headers['x-mera-turn-total']).toBe(String(all.length));
    expect(replay.headers['x-mera-turn-upstream-status']).toBe('200');
    expect(replay.headers['content-type']).toContain('application/octet-stream');
    expect(replay.headers['cache-control']).toBe('no-store');

    const tail = await call(port, 'GET', `/v1/chat/turns/${TURN}?after=11`);
    expect(tail.body.equals(all.subarray(11))).toBe(true);
    const past = await call(port, 'GET', `/v1/chat/turns/${TURN}?after=${all.length + 5}`);
    expect(past).toMatchObject({ status: 200 });
    expect(past.body).toHaveLength(0);
  });

  it('a buffered stream:false leg is relayed whole and stored the same', async () => {
    const port = await boot();
    const up = fakeUpstream('application/json');
    fetchSpy.mockResolvedValue(up.response);
    const doc = '{"choices":[{"message":{"content":"ciphertext"}}]}';

    const chat = startChat(port);
    up.push(doc.slice(0, 10));
    up.push(doc.slice(10));
    up.close();
    const res = await chat.reply;

    expect(res.body.toString()).toBe(doc);
    expect(res.headers['x-model-pub-key']).toBe('abcd');
    await until(async () => (await statusOf(port)) === 'done');
    const replay = await call(port, 'GET', `/v1/chat/turns/${TURN}`);
    expect(replay.body.toString()).toBe(doc);
  });

  it('a buffered leg survives a disconnect before the body arrived', async () => {
    const port = await boot();
    const up = fakeUpstream('application/json');
    fetchSpy.mockResolvedValue(up.response);

    const chat = startChat(port);
    chat.reply.catch(() => undefined); // the socket hang-up this test causes
    await until(() => fetchSpy.mock.calls.length > 0);
    chat.drop();
    await new Promise((r) => setTimeout(r, 30));
    up.push('{"choices":[]}');
    up.close();

    await until(async () => (await statusOf(port)) === 'done');
    expect((await call(port, 'GET', `/v1/chat/turns/${TURN}`)).body.toString()).toBe(
      '{"choices":[]}',
    );
  });

  it('another account gets exactly what an unknown id gets, on GET and DELETE', async () => {
    const port = await boot();
    const up = fakeUpstream();
    fetchSpy.mockResolvedValue(up.response);
    const chat = startChat(port);
    up.push('data: secret\n\n');
    await chat.started;

    const unknown = 'turn-ffffffffffffffff';
    const pick = ({ status, body }: Reply) => ({ status, body: body.toString() });
    for (const method of ['GET', 'DELETE']) {
      const theirs = await call(port, method, `/v1/chat/turns/${TURN}`, { 'x-test-user': 'bob' });
      const none = await call(port, method, `/v1/chat/turns/${unknown}`);
      expect(pick(theirs)).toEqual(pick(none));
      expect(theirs).toMatchObject({ status: 404 });
      expect(JSON.parse(theirs.body.toString())).toEqual({ code: 'turn-gone' });
    }
    expect(await statusOf(port)).toBe('running');
    up.close();
  });

  it('a second POST under a taken id cannot write into that turn', async () => {
    const port = await boot();
    const first = fakeUpstream();
    fetchSpy.mockResolvedValueOnce(first.response);
    const chat = startChat(port);
    first.push('data: mine\n\n');
    await chat.started;

    const second = fakeUpstream();
    fetchSpy.mockResolvedValueOnce(second.response);
    const other = startChat(port, { 'x-mera-turn-id': TURN, 'x-test-user': 'bob' });
    second.push('data: bob\n\n');
    second.close();
    expect((await other.reply).body.toString()).toBe('data: bob\n\n');

    first.close();
    await until(async () => (await statusOf(port)) === 'done');
    expect((await call(port, 'GET', `/v1/chat/turns/${TURN}`)).body.toString()).toBe(
      'data: mine\n\n',
    );
  });

  it('DELETE stops upstream on this instance and marks the turn cancelled', async () => {
    const port = await boot();
    const up = fakeUpstream();
    fetchSpy.mockResolvedValue(up.response);
    const chat = startChat(port);
    up.push('data: partial\n\n');
    await chat.started;

    const res = await call(port, 'DELETE', `/v1/chat/turns/${TURN}`);

    expect(res.status).toBe(204);
    await up.cancelled;
    await until(async () => (await statusOf(port)) === 'cancelled');
  });

  it('DELETE on another instance stops upstream through the stored flag', async () => {
    const [running, other] = [await boot(), await boot()];
    const up = fakeUpstream();
    fetchSpy.mockResolvedValue(up.response);
    startChat(running).reply.catch(() => undefined);
    up.push('data: partial\n\n');
    await until(async () => (await statusOf(other)) === 'running');

    const res = await call(other, 'DELETE', `/v1/chat/turns/${TURN}`);

    expect(res.status).toBe(204);
    await up.cancelled;
    expect(await statusOf(running)).toBe('cancelled');
  });

  it('DELETE after the end is a 204 and never rewrites the final status', async () => {
    const port = await boot();
    const up = fakeUpstream();
    fetchSpy.mockResolvedValue(up.response);
    const chat = startChat(port);
    up.push('data: x\n\n');
    up.close();
    await chat.reply;
    await until(async () => (await statusOf(port)) === 'done');

    expect((await call(port, 'DELETE', `/v1/chat/turns/${TURN}`)).status).toBe(204);
    expect(await statusOf(port)).toBe('done');
  });

  it('the hard deadline stops a turn that keeps talking, with or without a client', async () => {
    const port = await boot({ CHAT_TURN_DEADLINE_MS: '100' });
    const up = fakeUpstream();
    fetchSpy.mockResolvedValue(up.response);

    const chat = startChat(port);
    up.push('data: a\n\n');
    const res = await chat.reply;
    await up.cancelled;

    expect(res).toMatchObject({ status: 200, aborted: true });
    await until(async () => (await statusOf(port)) === 'error');
  });

  it('the idle timeout answers 502 before the first byte, with no upstream headers', async () => {
    const port = await boot({ CHAT_TURN_IDLE_TIMEOUT_MS: '100' });
    const up = fakeUpstream();
    fetchSpy.mockResolvedValue(up.response);

    const res = await startChat(port).reply;
    await up.cancelled;

    expect(res.status).toBe(502);
    expect(res.headers).not.toHaveProperty('x-model-pub-key');
    await until(async () => (await statusOf(port)) === 'error');
  });

  it('an upstream that never answers is cut by the idle timeout too', async () => {
    const port = await boot({ CHAT_TURN_IDLE_TIMEOUT_MS: '100' });
    fetchSpy.mockImplementation(
      (_url: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );

    expect((await startChat(port).reply).status).toBe(502);
    await until(async () => (await statusOf(port)) === 'error');
  });

  it('Redis failing mid-turn leaves the live response whole, and a replay says error', async () => {
    const port = await boot();
    jest.spyOn(store, 'appendTurn').mockRejectedValue(new Error('redis down'));
    const up = fakeUpstream();
    fetchSpy.mockResolvedValue(up.response);

    const chat = startChat(port);
    up.push('data: a\n\n');
    await new Promise((r) => setTimeout(r, 300)); // let a flush fail
    up.push('data: b\n\n');
    up.close();
    const res = await chat.reply;

    expect(res).toMatchObject({ status: 200, aborted: false });
    expect(res.body.toString()).toBe('data: a\n\ndata: b\n\n');
    await until(async () => (await statusOf(port)) === 'error');
  });

  it('a dead tee with no client stops upstream: nobody could ever read that reply', async () => {
    const port = await boot();
    jest.spyOn(store, 'appendTurn').mockRejectedValue(new Error('redis down'));
    const up = fakeUpstream();
    fetchSpy.mockResolvedValue(up.response);

    const chat = startChat(port);
    up.push('data: a\n\n');
    await chat.started;
    chat.drop();

    await up.cancelled;
  });

  it('Redis down at the claim falls back to a plain proxied reply', async () => {
    const port = await boot();
    jest.spyOn(store, 'beginTurn').mockRejectedValue(new Error('redis down'));
    const up = fakeUpstream();
    fetchSpy.mockResolvedValue(up.response);

    const chat = startChat(port);
    up.push('data: a\n\n');
    up.close();

    expect((await chat.reply).body.toString()).toBe('data: a\n\n');
  });

  it('a Redis that hangs at the claim costs a second, never the reply', async () => {
    const port = await boot();
    jest.spyOn(store, 'beginTurn').mockReturnValue(new Promise(() => undefined));
    const up = fakeUpstream();
    fetchSpy.mockResolvedValue(up.response);

    const chat = startChat(port);
    up.push('data: a\n\n');
    up.close();

    expect((await chat.reply).body.toString()).toBe('data: a\n\n');
  });

  it('a reply over the size cap still reaches the live client, and is not resumable', async () => {
    const port = await boot({ CHAT_TURN_MAX_BYTES: '4' });
    const up = fakeUpstream();
    fetchSpy.mockResolvedValue(up.response);

    const chat = startChat(port);
    up.push('data: too long\n\n');
    up.close();

    expect((await chat.reply).body.toString()).toBe('data: too long\n\n');
    await until(async () => (await statusOf(port)) === 'error');
  });

  it('a store that cannot answer is a 503, never a false turn-gone', async () => {
    const port = await boot();
    jest.spyOn(store, 'readTurn').mockRejectedValue(new Error('redis down'));
    jest.spyOn(store, 'getTurnMeta').mockRejectedValue(new Error('redis down'));

    for (const method of ['GET', 'DELETE']) {
      const res = await call(port, method, `/v1/chat/turns/${TURN}`);
      expect(res.status).toBe(503);
      expect(JSON.parse(res.body.toString())).toEqual({ code: 'turn-store-unavailable' });
    }
  });

  it('upstream non-2xx is relayed and stored as a status, never as bytes', async () => {
    const port = await boot();
    const up = fakeUpstream('application/json', 429);
    fetchSpy.mockResolvedValue(up.response);

    const chat = startChat(port);
    up.push('{"error":{"message":"slow down"},"echo":"reader text"}');
    up.close();
    const res = await chat.reply;

    expect(res.status).toBe(429);
    expect(res.body.toString()).toContain('reader text');
    await until(async () => (await statusOf(port)) === 'error');
    const replay = await call(port, 'GET', `/v1/chat/turns/${TURN}`);
    expect(replay.body).toHaveLength(0);
    expect(replay.headers['x-mera-turn-upstream-status']).toBe('429');
  });

  it('an empty upstream stream is the same 502, and a replay says error', async () => {
    const port = await boot();
    const up = fakeUpstream();
    fetchSpy.mockResolvedValue(up.response);

    const chat = startChat(port);
    up.close();

    expect((await chat.reply).status).toBe(502);
    await until(async () => (await statusOf(port)) === 'error');
  });

  it('a `running` nobody has written to since the idle window reads as error', async () => {
    const port = await boot();
    await store.beginTurn(TURN, 'alice');
    expect(await statusOf(port)).toBe('running');

    await redis.hset(KEY, 'updatedAt', String(Date.now() - 151_000));

    expect(await statusOf(port)).toBe('error');
  });

  it('evicted bytes read as gone, never as a finished empty reply', async () => {
    const port = await boot();
    await store.beginTurn(TURN, 'alice');
    await store.appendTurn(TURN, Buffer.from('data: x\n\n'));
    await store.finishTurn(TURN, 'done');
    await redis.del(`${KEY}:sse`);

    expect((await call(port, 'GET', `/v1/chat/turns/${TURN}`)).status).toBe(404);
  });

  it('every turn key carries a TTL, and an append cannot resurrect an evicted turn', async () => {
    const expectTurnTtl = async () => {
      for (const key of [KEY, `${KEY}:sse`]) {
        const ttl = await redis.ttl(key);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(3_600);
      }
    };
    await store.beginTurn(TURN, 'alice');
    expect(await redis.ttl(KEY)).toBeLessThanOrEqual(3_600);
    await store.appendTurn(TURN, Buffer.from('x'));
    await expectTurnTtl();
    await store.finishTurn(TURN, 'done');
    await expectTurnTtl();
    await store.beginTurn(`${TURN}-2`, 'alice');
    await store.appendTurn(`${TURN}-2`, Buffer.from('x'));

    await redis.del(`${KEY}-2:sse`);
    await expect(store.appendTurn(`${TURN}-2`, Buffer.from('y'))).rejects.toThrow();
    await redis.del(`${KEY}-2`);
    await expect(store.appendTurn(`${TURN}-2`, Buffer.from('y'))).rejects.toThrow();
    expect(await redis.exists(`${KEY}-2`)).toBe(0);
  });

  it('flag off: the header is ignored, Redis is untouched, a disconnect aborts upstream', async () => {
    const port = await boot({ CHAT_TURN_RESUME_ENABLED: undefined });
    const begin = jest.spyOn(store, 'beginTurn');
    const up = fakeUpstream();
    fetchSpy.mockResolvedValue(up.response);

    // An id that would be refused with the flag on: off, it is not even read.
    const chat = startChat(port, { 'x-mera-turn-id': '!' });
    up.push('data: a\n\n');
    await chat.started;
    chat.drop();
    await up.cancelled;

    expect(begin).not.toHaveBeenCalled();
    expect(await redis.keys('*')).toEqual([]);
    expect((await call(port, 'GET', `/v1/chat/turns/${TURN}`)).status).toBe(404);
    expect((await call(port, 'DELETE', `/v1/chat/turns/${TURN}`)).status).toBe(404);
  });

  it('no header: a disconnect aborts upstream as it always did', async () => {
    const port = await boot();
    const up = fakeUpstream();
    fetchSpy.mockResolvedValue(up.response);

    const chat = startChat(port, {});
    up.push('data: a\n\n');
    await chat.started;
    chat.drop();

    await up.cancelled;
    expect(await redis.keys('*')).toEqual([]);
  });

  it('refuses a malformed id before it reaches a Redis key', async () => {
    const port = await boot();
    for (const id of ['short', 'a'.repeat(65), 'turn:0123456789abcdef', '../../0123456789abcdef']) {
      expect((await startChat(port, { 'x-mera-turn-id': id }).reply).status).toBe(400);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await call(port, 'GET', `/v1/chat/turns/${TURN}?after=-1`)).status).toBe(400);
  });

  it('a capability token neither detaches a turn nor reads one', async () => {
    const port = await boot();
    const up = fakeUpstream();
    fetchSpy.mockResolvedValue(up.response);
    const chat = startChat(port, { 'x-mera-turn-id': TURN, 'x-test-capability': '1' });
    up.push('data: a\n\n');
    up.close();
    await chat.reply;
    expect(await redis.keys('*')).toEqual([]);

    await store.beginTurn(TURN, 'alice');
    const res = await call(port, 'GET', `/v1/chat/turns/${TURN}`, { 'x-test-capability': '1' });
    expect(res.status).toBe(404);
  });

  it('turns stay off the read meter', () => {
    const deps: unknown[] = Reflect.getMetadata('design:paramtypes', ChatTurnService) ?? [];
    expect(deps).not.toContain(ReadMeterService);
  });
});
