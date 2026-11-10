import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import request from 'supertest';

const RedisMock = require('ioredis-mock');
import { ProbeProcessor } from './probe.processor';
import { RoutingModule } from './routing.module';
import { RoutingService, ROUTING_PROBE_QUEUE, ROUTING_REDIS } from './routing.service';

// Bull Board is not under test; its feature module needs a real BullMQ queue.
jest.mock('@bull-board/nestjs', () => ({
  BullBoardModule: { forFeature: () => ({ module: class BullBoardFeatureStub {} }) },
}));

@Controller('boom')
class BoomController {
  @Get()
  boom() {
    throw new Error('gateway-made failure');
  }
}

@Module({ controllers: [BoomController] })
class BoomModule {}

describe('routing over HTTP (real module wiring, Redis mocked)', () => {
  let app: INestApplication;
  let routing: RoutingService;

  beforeAll(async () => {
    const redis = new RedisMock();
    await redis.flushall();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          isGlobal: true,
          load: [
            () => ({
              NEAR_AI_API_KEY: 'n',
              REDPILL_API_KEY: 'r',
              ROUTING_ADMIN_TOKEN: 'tok',
              ROUTING_PROBES_ENABLED: 'false',
            }),
          ],
        }),
        RoutingModule,
        BoomModule,
      ],
    })
      .overrideProvider(getQueueToken(ROUTING_PROBE_QUEUE))
      .useValue({ waitUntilReady: async () => undefined, add: async () => undefined })
      .overrideProvider(ROUTING_REDIS)
      .useValue(redis)
      // No Redis root here, so the real worker cannot start; its logic has its own spec.
      .overrideProvider(ProbeProcessor)
      .useValue({})
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    routing = moduleRef.get(RoutingService);
  });

  afterAll(async () => app?.close());

  it('stamps X-Mera-Routing on the table, on a 404 and on a handler error', async () => {
    const table = await request(app.getHttpServer()).get('/v1/routing').expect(200);
    expect(table.headers['x-mera-routing']).toBe('0');
    expect((await request(app.getHttpServer()).get('/nope')).headers['x-mera-routing']).toBe('0');
    const boom = await request(app.getHttpServer()).get('/boom').expect(500);
    expect(boom.headers['x-mera-routing']).toBe('0');
  });

  it('an admin pin moves the table and the header; no token or a wrong one is refused', async () => {
    const pin = { profile: 'near/qwen3.8-27b', state: 'down' };
    await request(app.getHttpServer()).post('/v1/routing/admin/pin').send(pin).expect(401);
    const res = await request(app.getHttpServer())
      .post('/v1/routing/admin/pin')
      .set('X-Mera-Admin-Token', 'tok')
      .send(pin)
      .expect(200);
    expect(res.body.lanes['chat-tools']).toEqual({
      state: 'degraded',
      profiles: ['near/qwen3.6-35b-a3b', 'redpill/qwen3.8-27b'],
    });
    // the 3s snapshot cache is dropped by the change on this instance
    const after = await request(app.getHttpServer()).get('/v1/routing').expect(200);
    expect(after.headers['x-mera-routing']).toBe('1');
    expect(await routing.isDown('near', 'Qwen/Qwen3.8-27B')).toBe(true);
  });
});
