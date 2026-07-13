import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import http from 'http';
import Redis from 'ioredis';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ChatService } from './../src/chat/chat.service';
import { JOB_STORE, JobStore } from './../src/inference-jobs/job-store.port';

/**
 * Full async-job cycle against the REAL RedisJobStore (Lua scripts included),
 * exercised through HTTP. Runs against the same redis:7 service container the
 * BullMQ queues use in CI.
 */
describe('InferenceGateway redis job store (e2e)', () => {
  let app: INestApplication<App>;
  let jwksServer: http.Server;
  let signJwt: (sub: string) => Promise<string>;
  let redis: Redis;

  const E2E_PREFIX = 'inf:e2e:';

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', {
      crv: 'Ed25519',
    });
    const publicJwk = await exportJWK(publicKey);
    publicJwk.alg = 'EdDSA';
    publicJwk.kid = 'test-key-001';

    jwksServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
    });
    await new Promise<void>((resolve) => jwksServer.listen(0, resolve));
    const jwksPort = (jwksServer.address() as { port: number }).port;

    signJwt = (sub: string) =>
      new SignJWT({ subscriptionIsActive: true })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'test-key-001' })
        .setIssuer(process.env.AUTH_JWT_ISSUER ?? 'mera-server-auth')
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);

    process.env.NEAR_AI_API_KEY = 'test-key';
    process.env.AUTH_JWKS_URL = `http://localhost:${jwksPort}/jwks`;
    process.env.INFERENCE_CAPABILITY_SECRET = 'a'.repeat(64);
    // Same localhost pinning rationale as app.e2e-spec.ts.
    process.env.INFERENCE_REDIS_URL = process.env.MERA_E2E_REDIS_URL ?? 'redis://localhost:6379';
    process.env.INFERENCE_JOBS_REDIS_URL =
      process.env.MERA_E2E_REDIS_URL ?? 'redis://localhost:6379';
    process.env.INFERENCE_JOBS_KEY_PREFIX = E2E_PREFIX;
    // Low cap so the byte-cap 413 can be exercised through HTTP while staying
    // under the test app's default express body-parser limit (100KB).
    process.env.INFERENCE_MAX_JOB_BYTES = '2048';
    // Isolate this suite's BullMQ keys from app.e2e-spec.ts runs on the same
    // redis container.
    process.env.BULLMQ_PREFIX = 'bull-e2e';

    // Deferred CJS load — JobStoreModule.register() reads process.env at
    // module-body import time, so AppModule must not be imported statically.

    const { AppModule } = require('./../src/app.module') as typeof import('./../src/app.module');
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ChatService)
      .useValue({
        // Upstream stub: echoes a ciphertext-shaped body per request.
        proxyChat: jest.fn().mockImplementation(async () => ({
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'CIPHERTEXT' } }] }),
          text: async () => '',
        })),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();

    redis = new Redis(process.env.INFERENCE_JOBS_REDIS_URL);
  }, 30_000);

  afterAll(async () => {
    // Clean this suite's namespace so repeated local runs start fresh.
    if (redis) {
      const keys = await redis.keys(`${E2E_PREFIX}*`);
      if (keys.length > 0) await redis.del(...keys);
      await redis.quit();
    }
    await app?.close();
    jwksServer?.close();
  }, 15_000);

  it('GET /health should return 200 (redis store pings)', () => {
    return request(app.getHttpServer()).get('/health').expect(200).expect({ status: 'ok' });
  });

  it('runs a full submit -> process -> poll cycle', async () => {
    const jwt = await signJwt('user-e2e');

    const submit = await request(app.getHttpServer())
      .post('/v1/inference/jobs')
      .set('Authorization', `Bearer ${jwt}`)
      .send({
        sharedSystem: 'SHARED-CIPHER',
        requests: [
          { id: 'req-a', body: { messages: [{ role: 'user', content: 'CT-A' }] } },
          { id: 'req-b', body: { messages: [{ role: 'user', content: 'CT-B' }] } },
        ],
      })
      .expect(202);

    const { requestId, capabilityToken } = submit.body as {
      requestId: string;
      capabilityToken: string;
    };
    expect(requestId).toMatch(/^[0-9a-f]{24}$/);
    expect(capabilityToken).toBeTruthy();

    // Poll until the BullMQ flow completes end-to-end (children + finalize).
    const deadline = Date.now() + 20_000;
    let results: Array<{ id: string; ok: boolean; response: unknown; error: unknown }> | null =
      null;
    while (Date.now() < deadline) {
      const poll = await request(app.getHttpServer())
        .get(`/v1/inference/jobs/${requestId}/results`)
        .set('Authorization', `Bearer ${capabilityToken}`)
        .expect(200);
      if (!(poll.body as { pending?: boolean }).pending) {
        results = (poll.body as { results: typeof results }).results;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    expect(results).not.toBeNull();
    expect(results).toHaveLength(2);
    const ids = results!.map((r) => r.id).sort();
    expect(ids).toEqual(['req-a', 'req-b']);
    for (const r of results!) {
      expect(r.ok).toBe(true);
      expect(r.response).toEqual({ choices: [{ message: { content: 'CIPHERTEXT' } }] });
      expect(r.error).toBeNull();
    }

    // Key hygiene: everything this job wrote is namespaced and TTL'd.
    const jobKeys = await redis.keys(`${E2E_PREFIX}job:${requestId}*`);
    expect(jobKeys.length).toBeGreaterThanOrEqual(2);
    for (const key of jobKeys) {
      expect(await redis.ttl(key)).toBeGreaterThan(0);
    }
  }, 30_000);

  it('exercises the real Lua idempotency: double append is a no-op', async () => {
    const store = app.get<JobStore>(JOB_STORE);
    const id = await store.createJob({
      userId: 'user-lua',
      expoPushToken: null,
      e2eeSession: null,
      requests: [{ id: 'only', body: {} }],
      sharedSystem: null,
    });

    const result = { id: 'only', ok: true, response: { n: 1 }, error: null };
    await store.appendResult(id, 0, result);
    await store.appendResult(id, 0, { ...result, response: { n: 2 } });

    const completedCount = await redis.hget(`${E2E_PREFIX}job:${id}`, 'completedCount');
    expect(completedCount).toBe('1');

    const view = await store.getResultsView(id);
    expect(view?.results).toHaveLength(1);
    // First write wins — the duplicate never overwrites.
    expect(view?.results[0].response).toEqual({ n: 1 });
    // Late duplicates can never regress status past processing.
    await store.finalizeJob(id);
    await store.appendResult(id, 0, result);
    const status = await redis.hget(`${E2E_PREFIX}job:${id}`, 'status');
    expect(status).toBe('completed');
  });

  it('refuses to serve results to a different authenticated user (403)', async () => {
    const ownerJwt = await signJwt('owner-user');
    const submit = await request(app.getHttpServer())
      .post('/v1/inference/jobs')
      .set('Authorization', `Bearer ${ownerJwt}`)
      .send({ requests: [{ id: 'r', body: {} }] })
      .expect(202);
    const { requestId } = submit.body as { requestId: string };

    const attackerJwt = await signJwt('attacker-user');
    await request(app.getHttpServer())
      .get(`/v1/inference/jobs/${requestId}/results`)
      .set('Authorization', `Bearer ${attackerJwt}`)
      .expect(403);
  });

  it('rejects a job payload above INFERENCE_MAX_JOB_BYTES with 413', async () => {
    // 10KB ciphertext: under the express body-parser limit, over the 2KB cap
    // configured for this suite — the 413 must come from the store's cap.
    const jwt = await signJwt('user-big');
    const res = await request(app.getHttpServer())
      .post('/v1/inference/jobs')
      .set('Authorization', `Bearer ${jwt}`)
      .send({
        requests: [{ id: 'big', body: { blob: 'x'.repeat(10 * 1024) } }],
      })
      .expect(413);
    expect((res.body as { message?: string }).message).toMatch(/byte limit/);
  });

  it('returns 404 for an unknown (expired) requestId', async () => {
    const jwt = await signJwt('user-e2e');
    await request(app.getHttpServer())
      .get(`/v1/inference/jobs/${'f'.repeat(24)}/results`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(404);
  });
});
