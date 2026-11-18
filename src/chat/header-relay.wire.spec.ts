import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as zlib from 'node:zlib';
import request from 'supertest';
import { AuthGuard } from '../auth/auth.guard';
import { JOB_STORE } from '../inference-jobs/job-store.port';
import { RoutingService } from '../routing/routing.service';
import { ChatService } from './chat.service';
import { ChatTurnService } from './chat-turn.service';
import { CompletionsController } from './completions.controller';
import { InferenceQueueService } from './inference-queue.service';

/**
 * Which upstream response headers reach the client, over real HTTP. The
 * provider is faked at the network edge (global fetch), except in the gzip
 * case, where a loopback server is fetched for real so fetch does the decoding.
 */
const ROUTING_UP = {
  keyFor: () => 'k',
  isDown: async () => false,
  allDown: async () => false,
  isDownCached: () => false,
  reportFailure: () => undefined,
  unavailableBody: async () => ({}),
};

const BODY = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

describe('upstream response headers on POST /v1/chat/completions', () => {
  let app: INestApplication;
  let fetchSpy: jest.SpyInstance;
  const realFetch = globalThis.fetch;

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

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => jest.restoreAllMocks());

  it('relays only content-type and x-e2ee-* from the upstream reply', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ id: 'r1', choices: [] }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'session=SECRET; Path=/',
          'x-internal-trace': 'trace-1',
          'x-e2ee-applied': 'true',
        },
      }),
    );

    const res = await request(app.getHttpServer()).post('/v1/chat/completions').send(BODY);

    expect(res.status).toBe(200);
    expect(res.headers['x-e2ee-applied']).toBe('true');
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['x-internal-trace']).toBeUndefined();
  });

  it('sends a gzip-encoded upstream error body readable and without content-encoding', async () => {
    const payload = JSON.stringify({ error: { message: 'model overloaded' } });
    const upstreamServer = http.createServer((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync(payload));
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
    const { port } = upstreamServer.address() as AddressInfo;
    // Send the controller's upstream call to the loopback server, with a real fetch.
    fetchSpy.mockImplementation(() => realFetch(`http://127.0.0.1:${port}/`));

    try {
      const res = await request(app.getHttpServer()).post('/v1/chat/completions').send(BODY);

      expect(res.status).toBe(429);
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.text).toContain('model overloaded');
    } finally {
      await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    }
  });
});
