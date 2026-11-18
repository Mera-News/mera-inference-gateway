import { Body, Controller, INestApplication, Logger, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { json } from 'express';
import request from 'supertest';
import { HttpExceptionFilter } from './http-exception.filter';

/**
 * A request body that is not JSON, through the real Express body parser and Nest's
 * adapter, which re-throws the parser's SyntaxError as a bare BadRequestException
 * carrying the parser's message. That message quotes the body, so it must reach
 * neither a log line nor the response.
 */
const LEAK = 'LEAK7';

@Controller()
class EchoController {
  @Post('echo')
  echo(@Body() body: unknown) {
    return body;
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

describe('a request body that is not JSON, on the wire', () => {
  let app: INestApplication;
  const lines: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [EchoController] }).compile();
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

  it.each([
    ['a chat body cut inside its content', `{"model":"m","messages":[{"content":${LEAK} x}]}`],
    ['a search query without its quotes', `{"query":${LEAK} what happened}`],
    ['a body that is not JSON at all', `${LEAK}`],
  ])('%s: a fixed 400, and no slice of it logged or returned', async (_, body) => {
    const res = await request(app.getHttpServer())
      .post('/echo')
      .set('content-type', 'application/json')
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Request body is not valid JSON');
    expect(res.text).not.toContain(LEAK);
    expect(lines.join('\n')).not.toContain(LEAK);
  });
});
