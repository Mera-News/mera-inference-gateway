import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import http from 'http';
import { AppModule } from './../src/app.module';
import { exportJWK, generateKeyPair } from 'jose';

describe('InferenceGateway (e2e)', () => {
  let app: INestApplication<App>;
  let jwksServer: http.Server;

  beforeAll(async () => {
    // Generate a test Ed25519 keypair and serve the public key via a local JWKS server
    const { publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
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
    // AppModule opens these connections on boot (Mongoose blocks init until it
    // connects). The GitHub workflow provisions redis + mongo service containers
    // on these localhost ports. Overridable so a dev can point at a Mongo/Redis
    // on a non-default port (e.g. when 27017/6379 are taken locally).
    process.env.INFERENCE_REDIS_URL ??= 'redis://localhost:6379';
    process.env.INFERENCE_MONGODB_URI ??= 'mongodb://localhost:27017/mera-inference-e2e';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    // app.init() establishes the Mongoose connection and starts BullMQ workers,
    // which exceeds jest's default 5s hook budget on a cold connection.
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
