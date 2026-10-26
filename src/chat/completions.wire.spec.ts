import { INestApplication, Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import http from 'http';
import type { AddressInfo } from 'net';
import { AuthGuard } from '../auth/auth.guard';
import { ChatService } from './chat.service';
import { CompletionsController } from './completions.controller';
import { InferenceQueueService } from './inference-queue.service';

/**
 * What the CLIENT receives on the wire when NEAR misbehaves after a 2xx. The
 * mock-res specs in completions.controller.spec.ts cannot show this: the bug
 * class here is "the socket closed and the client read it as a clean, empty
 * success". Faked at the network edge (global fetch); the gateway is real.
 */

type WireResult =
  | { kind: 'response'; status: number; contentType: string; body: string }
  | { kind: 'aborted'; status: number; partial: string };

const enc = new TextEncoder();

function upstreamResponse(
  contentType: string,
  pull: (c: ReadableStreamDefaultController<Uint8Array>) => void | Promise<void>,
): Response {
  return new Response(new ReadableStream<Uint8Array>({ pull }), {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

/** POST with raw http so a truncated body shows as an abort, not a parse error. */
function post(port: number): Promise<WireResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('aborted', () =>
          resolve({ kind: 'aborted', status: res.statusCode!, partial: body }),
        );
        res.on('error', () => resolve({ kind: 'aborted', status: res.statusCode!, partial: body }));
        res.on('end', () => {
          if (!res.complete) return; // 'aborted' already resolved
          resolve({
            kind: 'response',
            status: res.statusCode!,
            contentType: String(res.headers['content-type'] ?? ''),
            body,
          });
        });
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'm', stream: true, messages: [] }));
  });
}

describe('chatCompletions on the wire (fake NEAR at fetch)', () => {
  let app: INestApplication;
  let port: number;
  let fetchSpy: jest.SpyInstance;

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
      providers: [ChatService, InferenceQueueService],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => jest.restoreAllMocks());

  it('upstream 200 JSON with an empty body: the client gets a 502, never an empty 2xx', async () => {
    fetchSpy.mockResolvedValue(upstreamResponse('application/json', (c) => c.close()));

    const res = await post(port);

    expect(res).toMatchObject({ kind: 'response', status: 502 });
    expect(JSON.parse((res as { body: string }).body)).toEqual({
      error: 'Upstream returned an empty body',
    });
  });

  it('upstream JSON errors mid-body: the client gets a 502, never an empty or truncated 2xx', async () => {
    let sent = false;
    fetchSpy.mockResolvedValue(
      upstreamResponse('application/json', async (c) => {
        if (!sent) {
          sent = true;
          c.enqueue(enc.encode('{"choices":[{"mess'));
          return;
        }
        await new Promise((r) => setTimeout(r, 50)); // let the first bytes reach the socket
        c.error(new TypeError('terminated'));
      }),
    );

    const res = await post(port);

    expect(res).toMatchObject({ kind: 'response', status: 502 });
  });

  // Before the fix pipe() left res open here and this request hung forever.
  it('upstream SSE errors after a delta: the client sees an aborted body, not a hang', async () => {
    let sent = false;
    fetchSpy.mockResolvedValue(
      upstreamResponse('text/event-stream', async (c) => {
        if (!sent) {
          sent = true;
          c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
          return;
        }
        await new Promise((r) => setTimeout(r, 50)); // let the first bytes reach the socket
        c.error(new TypeError('terminated'));
      }),
    );

    const res = await post(port);

    expect(res).toMatchObject({ kind: 'aborted', status: 200 });
    expect((res as { partial: string }).partial).toContain('"content":"x"');
  });

  it('upstream SSE errors before any byte: the client gets a 5xx', async () => {
    fetchSpy.mockResolvedValue(
      upstreamResponse('text/event-stream', (c) => c.error(new TypeError('terminated'))),
    );

    const res = await post(port);

    expect(res).toMatchObject({ kind: 'response', status: 500 });
  });
});
