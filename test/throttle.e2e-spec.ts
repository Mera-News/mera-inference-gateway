/**
 * Rate limiting, end to end, against a LIVE Redis.
 *
 * Why this file exists separately from app.e2e-spec.ts: THROTTLE_LIMIT is read
 * once when AppModule is constructed, so a low limit cannot be scoped to a few
 * tests inside a suite that boots the app in beforeAll. It also must not be
 * low for that suite's other requests.
 *
 * Why the obvious version of this test is worthless: "hit /health N times and
 * assert 200" passes identically when @SkipThrottle is removed, when Redis is
 * down, and when the throttler is broken end to end -- because the storage
 * fails OPEN. So this suite pins a LOW limit, requires a REACHABLE Redis
 * (beforeAll fails otherwise rather than silently proving nothing), and
 * asserts both sides of the contrast in the same run: /health stays 200 past
 * the limit while a guarded route trips to 429.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import http from 'http';
import Redis from 'ioredis';
import { randomBytes } from 'crypto';

const LIMIT = 5;

describe('Rate limiting (e2e)', () => {
  let app: INestApplication<App>;
  let jwksServer: http.Server;
  let prefix: string;
  let redisUrl: string;
  // This suite pins a deliberately LOW limit. jest runs the e2e files in ONE
  // process (--runInBand), and redis-store.e2e-spec.ts sets no THROTTLE_LIMIT
  // of its own, so leaking this would silently 429 whichever suite runs next.
  // Current file ordering happens to be safe; that is incidental, not a
  // guarantee. Snapshot and restore instead of relying on it.
  const savedEnv: Record<string, string | undefined> = {};
  const OWNED_ENV = ['THROTTLE_TTL', 'THROTTLE_LIMIT', 'BULLMQ_PREFIX'] as const;

  beforeAll(async () => {
    redisUrl = process.env.MERA_E2E_REDIS_URL ?? 'redis://localhost:6379';

    // Fail loudly if Redis is unreachable. Without this the storage fails open
    // and every assertion below would pass while testing nothing.
    const probe = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
    try {
      await probe.connect();
      await probe.ping();
    } finally {
      probe.disconnect();
    }

    jwksServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [] }));
    });
    await new Promise<void>((resolve) => jwksServer.listen(0, resolve));
    const jwksPort = (jwksServer.address() as { port: number }).port;

    prefix = `e2e-throttle-${randomBytes(4).toString('hex')}`;

    process.env.NEAR_AI_API_KEY = 'test-key';
    process.env.AUTH_JWKS_URL = `http://localhost:${jwksPort}/jwks`;
    process.env.INFERENCE_CAPABILITY_SECRET = 'a'.repeat(64);
    process.env.INFERENCE_REDIS_URL = redisUrl;
    process.env.INFERENCE_JOBS_REDIS_URL = redisUrl;
    for (const key of OWNED_ENV) savedEnv[key] = process.env[key];
    process.env.BULLMQ_PREFIX = prefix;
    process.env.THROTTLE_TTL = '60';
    process.env.THROTTLE_LIMIT = String(LIMIT);

    const { AppModule } = require('./../src/app.module') as typeof import('./../src/app.module');
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
    if (jwksServer) await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
    // Leave no throttle keys behind for the next run.
    const cleanup = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    const keys = await cleanup.keys(`${prefix}:throttle:*`);
    if (keys.length > 0) await cleanup.del(...keys);
    await cleanup.quit();

    for (const key of OWNED_ENV) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }, 30_000);

  /**
   * Requests that arrive while the throttle Redis client is still connecting
   * FAIL OPEN and are not counted -- enableOfflineQueue is false, so commands
   * issued before the socket is up reject immediately rather than queueing.
   * That is the intended cold-start behaviour (a brand new instance would
   * rather serve a few uncounted requests than stall them), but a test that
   * races it is flaky. Drive requests until the store is demonstrably
   * counting, then reset the counters and start the real measurement.
   */
  async function waitUntilCounting(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const res = await request(app.getHttpServer()).post('/v1/chat/completions').send({});
      const remaining = Number(res.headers['x-ratelimit-remaining']);
      // The fail-open record reports totalHits 0, i.e. remaining === LIMIT.
      // Anything lower means a real INCR landed in Redis.
      if (Number.isFinite(remaining) && remaining < LIMIT) return;
    }
    throw new Error('throttle store never started counting');
  }

  async function resetCounters(): Promise<void> {
    const client = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    try {
      const keys = await client.keys(`${prefix}:throttle:*`);
      if (keys.length > 0) await client.del(...keys);
    } finally {
      await client.quit();
    }
  }

  it('enforces the limit on a guarded route and returns 429 past it', async () => {
    const server = app.getHttpServer();
    await waitUntilCounting();
    await resetCounters();

    // No Authorization header, so every one of these is unauthenticated and
    // would 401. The throttler still counts them, because ThrottlerGuard is a
    // global APP_GUARD and AuthGuard is controller-scoped -- globals run first.
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT + 1; i++) {
      const res = await request(server).post('/v1/chat/completions').send({});
      statuses.push(res.status);
    }

    // The run of 401s proves the counter is shared across requests (an
    // always-fresh counter would 401 forever) and that the ip: fallback bucket
    // works. The final 429 proves the limit is enforced, and its arrival
    // BEFORE auth proves the guard ordering the tracker depends on.
    expect(statuses.slice(0, LIMIT)).toEqual(Array<number>(LIMIT).fill(401));
    expect(statuses[LIMIT]).toBe(429);
  }, 30_000);

  it('leaves /health unthrottled well past the limit', async () => {
    const server = app.getHttpServer();
    // The guarded route is already over its limit from the test above, so a
    // 200 here cannot be explained by a fresh or failing-open counter.
    await waitUntilCounting().catch(() => undefined);
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT + 5; i++) {
      const res = await request(server).get('/health');
      statuses.push(res.status);
    }
    expect(statuses).toEqual(Array<number>(LIMIT + 5).fill(200));
  }, 30_000);

  it('writes its counters under the BULLMQ_PREFIX namespace', async () => {
    const client = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    try {
      const keys = await client.keys(`${prefix}:throttle:*`);
      expect(keys.length).toBeGreaterThan(0);
    } finally {
      await client.quit();
    }
  }, 30_000);
});
