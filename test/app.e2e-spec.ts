import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import http from 'http';
import { exportJWK, generateKeyPair } from 'jose';

describe('InferenceGateway (e2e)', () => {
  let app: INestApplication<App>;
  let jwksServer: http.Server;

  beforeAll(async () => {
    // Generate a test Ed25519 keypair and serve the public key via a local JWKS server
    const { publicKey } = await generateKeyPair('EdDSA', {
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

    process.env.NEAR_AI_API_KEY = 'test-key';
    process.env.AUTH_JWKS_URL = `http://localhost:${jwksPort}/jwks`;
    // Valid 32-byte hex secret — the .env.example placeholder is not hex and
    // would make CapabilityTokenService.onModuleInit throw at boot.
    process.env.INFERENCE_CAPABILITY_SECRET = 'a'.repeat(64);
    // AppModule opens Redis connections on boot (BullMQ + the job store). The
    // GitHub workflow provisions a redis service container on this localhost
    // port. Pin to localhost (hard-set, not ??=) so a stray URL in the dev's
    // shell can't redirect the e2e at a remote instance. E2E is always meant to
    // run against the ephemeral local/CI services. Override via MERA_E2E_* if
    // 6379 is taken locally.
    process.env.INFERENCE_REDIS_URL = process.env.MERA_E2E_REDIS_URL ?? 'redis://localhost:6379';
    // Job payloads/results live on the dedicated job-store Redis (same
    // container here). Import AppModule only AFTER env is set:
    // JobStoreModule.register() reads process.env at module-body import time,
    // and redis-store.e2e-spec.ts mutates the same process env.
    process.env.INFERENCE_JOBS_REDIS_URL =
      process.env.MERA_E2E_REDIS_URL ?? 'redis://localhost:6379';

    const { AppModule } = require('./../src/app.module') as typeof import('./../src/app.module');
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    // app.init() connects to Redis and starts BullMQ workers, which exceeds
    // jest's default 5s hook budget on a cold connection.
  }, 30_000);

  afterAll(async () => {
    // Guard: if beforeAll threw before assigning `app`, app.close() would itself
    // throw and mask the real boot error.
    await app?.close();
    jwksServer?.close();
  }, 15_000);

  it('GET /health should return 200', () => {
    return request(app.getHttpServer()).get('/health').expect(200).expect({ status: 'ok' });
  });

  it('POST /v1/chat/completions without auth should return 401', () => {
    return request(app.getHttpServer())
      .post('/v1/chat/completions')
      .send({ messages: [{ role: 'user', content: 'hello' }] })
      .expect(401);
  });

  it('POST /v1/chat/completions/batch without auth should return 401', () => {
    return request(app.getHttpServer())
      .post('/v1/chat/completions/batch')
      .send({ requests: [{ messages: [{ role: 'user', content: 'hello' }] }] })
      .expect(401);
  });
});
