import {
  BadRequestException,
  Body,
  Controller,
  Get,
  INestApplication,
  Logger,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { json } from 'express';
import request from 'supertest';
import { ExpoPushService } from '../notifications/expo-push.service';
import { HttpExceptionFilter } from './http-exception.filter';

/**
 * Whatever a caller puts in a query string or a push token must not reach any
 * Logger call, at any level, whether the request ends in a 404, a 400 or a
 * rejected token. Real HTTP through the real filter and body parser.
 */
const LEAK = 'LEAK7';

@Controller()
class ProbeController {
  @Post('echo')
  echo(@Body() body: unknown) {
    return body;
  }

  @Get('reject')
  reject() {
    throw new BadRequestException('bad input');
  }
}

/** An Error from another realm fails `instanceof Error` here, so read its fields by name. */
function asText(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'object' && arg !== null && 'stack' in arg) {
    const e = arg as { name?: unknown; message?: unknown; stack?: unknown };
    return `${String(e.name)}: ${String(e.message)} ${String(e.stack)}`;
  }
  return JSON.stringify(arg);
}

describe('log hygiene on the wire', () => {
  let app: INestApplication;
  const lines: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    app = moduleRef.createNestApplication({ logger: false, bodyParser: false });
    app.use(json({ limit: '50mb' }));
    app.useGlobalFilters(new HttpExceptionFilter(true));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    lines.length = 0;
    for (const level of ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(asText).join(' '));
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it('a 404 with a query string logs the path without the query', async () => {
    const res = await request(app.getHttpServer()).get(`/missing?x=${LEAK}`);

    expect(res.status).toBe(404);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(LEAK);
  });

  it('a 400 from a handler with a query string logs the path without the query', async () => {
    const res = await request(app.getHttpServer()).get(`/reject?x=${LEAK}`);

    expect(res.status).toBe(400);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(LEAK);
  });

  it('a 400 for an unparseable body with a query string logs the path without the query', async () => {
    const res = await request(app.getHttpServer())
      .post(`/echo?x=${LEAK}`)
      .set('content-type', 'application/json')
      .send('{"a":nope');

    expect(res.status).toBe(400);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(LEAK);
  });

  it('an invalid push token is not logged', async () => {
    await new ExpoPushService(new ConfigService({})).sendSilent({ to: LEAK, data: {} });

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(LEAK);
  });
});
