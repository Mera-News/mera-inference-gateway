import { INestApplication, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Job } from 'bullmq';
import RedisMock from 'ioredis-mock';
import request from 'supertest';
import { AuthGuard } from '../auth/auth.guard';
import { JOB_STORE } from '../inference-jobs/job-store.port';
import { RedisJobStore } from '../inference-jobs/redis-job-store';
import { LlmInferenceProcessor } from '../queues/llm-inference.processor';
import { RoutingService } from '../routing/routing.service';
import { ChatService } from './chat.service';
import { ChatTurnService } from './chat-turn.service';
import { CompletionsController } from './completions.controller';
import { InferenceQueueService } from './inference-queue.service';

/**
 * A 2xx from the provider whose body is not JSON. The parser's error message
 * quotes the text it failed on, so it must never reach a log line, a stored
 * job result or a response. Faked at the network edge (global fetch).
 */
const LEAK = 'LEAK7';

/** Malformed inside the reply, and a provider error page sent with a 200. */
const BODIES: Array<[string, string, string]> = [
  [
    'a reply cut inside its content',
    'application/json',
    `{"id":"r1","choices":[{"message":{"role":"assistant","content":${LEAK} reply}}]}`,
  ],
  ['an error page sent with a 200', 'text/html', `<p>${LEAK}</p>`],
];

const ROUTING_UP = {
  keyFor: () => 'k',
  isDown: async () => false,
  allDown: async () => false,
  isDownCached: () => false,
  reportFailure: () => undefined,
  unavailableBody: async () => ({}),
};

/** An Error from fetch's realm fails `instanceof Error` here, so read its fields by name. */
function asText(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'object' && arg !== null && 'stack' in arg) {
    const e = arg as { name?: unknown; message?: unknown; stack?: unknown };
    return `${String(e.name)}: ${String(e.message)} ${String(e.stack)}`;
  }
  return JSON.stringify(arg);
}

/** Every Logger call at every level, as text: the most verbose view. */
function captureLogs(): () => string {
  const lines: string[] = [];
  for (const level of ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(asText).join(' '));
    });
  }
  return () => lines.join('\n');
}

function upstream(contentType: string, body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

describe('a 2xx upstream body that is not JSON', () => {
  let logs: () => string;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    logs = captureLogs();
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => jest.restoreAllMocks());

  describe('POST /v1/chat/completions/batch', () => {
    let app: INestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            ignoreEnvFile: true,
            isGlobal: true,
            load: [() => ({ NEAR_AI_API_KEY: 'k' })],
          }),
        ],
        controllers: [CompletionsController],
        providers: [
          ChatService,
          ChatTurnService,
          { provide: RoutingService, useValue: ROUTING_UP },
          InferenceQueueService,
          { provide: JOB_STORE, useValue: {} },
        ],
      })
        .overrideGuard(AuthGuard)
        .useValue({ canActivate: () => true })
        .compile();
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterAll(async () => {
      await app?.close();
    });

    it.each(BODIES)('%s: no slice of it in a log line or the response', async (_, type, body) => {
      fetchSpy.mockResolvedValue(upstream(type, body));

      const res = await request(app.getHttpServer())
        .post('/v1/chat/completions/batch')
        .send({ requests: [{ model: 'm', messages: [] }] });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ results: [{ index: 0, error: 'Request failed' }] });
      expect(res.text).not.toContain(LEAK);
      expect(logs()).not.toContain(LEAK);
    });
  });

  describe('the llm-inference worker', () => {
    let redis: InstanceType<typeof RedisMock>;
    let store: RedisJobStore;
    let processor: LlmInferenceProcessor;

    beforeEach(async () => {
      redis = new RedisMock();
      await redis.flushall();
      store = new RedisJobStore(redis, {
        keyPrefix: 'inf:',
        resultTtlSeconds: 86_400,
        bodyTtlSeconds: 7_200,
        turnTtlSeconds: 3_600,
        maxJobBytes: 5_242_880,
      });
      const config = new ConfigService({ NEAR_AI_API_KEY: 'k' });
      const chat = new ChatService(config, ROUTING_UP as unknown as RoutingService);
      processor = new LlmInferenceProcessor(chat, store);
    });

    afterEach(() => redis.disconnect());

    it.each(BODIES)(
      '%s: no slice of it in a log line or the stored result',
      async (_, type, body) => {
        fetchSpy.mockResolvedValue(upstream(type, body));
        const jobId = await store.createJob({
          userId: 'u1',
          expoPushToken: null,
          e2eeSession: null,
          requests: [{ id: 'r1', body: { model: 'm', messages: [] } }],
          sharedSystem: null,
        });

        await processor.process({ data: { jobId, requestIndex: 0 } } as Job<{
          jobId: string;
          requestIndex: number;
        }>);
        // No finalizeJob: its Lua needs cjson, which ioredis-mock lacks. The result row is read as is.
        const view = await store.getResultsView(jobId);

        expect(view?.results).toEqual([
          { id: 'r1', ok: false, response: null, error: 'upstream body is not valid JSON' },
        ]);
        expect(JSON.stringify(view)).not.toContain(LEAK);
        expect(logs()).not.toContain(LEAK);
      },
    );
  });
});
