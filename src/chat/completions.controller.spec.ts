import { Logger } from '@nestjs/common';
import type { Response } from 'express';
import { Readable } from 'stream';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { ChatService } from './chat.service';
import { CompletionsController } from './completions.controller';
import { InferenceQueueService } from './inference-queue.service';

function makeRes(headersSent = false): Response & {
  status: jest.Mock;
  json: jest.Mock;
  send: jest.Mock;
  setHeader: jest.Mock;
  headersSent: boolean;
} {
  const res: Record<string, jest.Mock | boolean> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn().mockReturnValue(res);
  res.headersSent = headersSent;
  return res as unknown as Response & {
    status: jest.Mock;
    json: jest.Mock;
    send: jest.Mock;
    setHeader: jest.Mock;
    headersSent: boolean;
  };
}

function makeReq(
  body: unknown,
  headers: Record<string, string | string[]> = {},
): AuthenticatedRequest {
  return {
    body,
    headers,
    user: { id: 'user-1', subscriptionIsActive: true },
  } as unknown as AuthenticatedRequest;
}

/** Build a minimal upstream response that mimics the fetch Response shape. */
function makeUpstream(
  opts: {
    ok?: boolean;
    status?: number;
    headerMap?: Record<string, string>;
    text?: () => Promise<string>;
    json?: () => Promise<unknown>;
    body?: unknown;
  } = {},
) {
  const {
    ok = true,
    status = 200,
    headerMap = {},
    text = jest.fn<Promise<string>, []>().mockResolvedValue(''),
    json = jest.fn<Promise<unknown>, []>().mockResolvedValue({}),
    body = null,
  } = opts;

  return {
    ok,
    status,
    headers: {
      forEach: (cb: (value: string, name: string) => void) => {
        for (const [name, value] of Object.entries(headerMap)) {
          cb(value, name);
        }
      },
    },
    text,
    json,
    body,
  };
}

// ---------------------------------------------------------------------------
// Shared setup helpers
// ---------------------------------------------------------------------------

function makeControllerAndDeps() {
  const chatService = { proxyChat: jest.fn() };
  const queue = {
    canAccept: jest.fn(),
    snapshot: jest.fn().mockReturnValue({ active: 0, waiting: 0 }),
    run: jest.fn((task: () => Promise<unknown>) => task()),
  };
  const controller = new CompletionsController(
    chatService as unknown as ChatService,
    queue as unknown as InferenceQueueService,
  );
  return { chatService, queue, controller };
}

// ---------------------------------------------------------------------------
// Streaming endpoint
// ---------------------------------------------------------------------------

describe('chatCompletions (streaming)', () => {
  let chatService: { proxyChat: jest.Mock };
  let controller: CompletionsController;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    ({ chatService, controller } = makeControllerAndDeps());
  });

  afterEach(() => jest.restoreAllMocks());

  it('forwards upstream status and allowed headers, blocks authorization and transfer-encoding', async () => {
    const upstream = makeUpstream({
      ok: true,
      status: 206,
      headerMap: {
        'content-type': 'text/event-stream',
        'authorization': 'secret',
        'transfer-encoding': 'chunked',
      },
      body: {} as unknown,
    });
    jest.spyOn(Readable, 'fromWeb').mockReturnValue({ pipe: jest.fn(), on: jest.fn() } as any);
    chatService.proxyChat.mockResolvedValue(upstream);

    const res = makeRes();
    await controller.chatCompletions(makeReq({}), res);

    expect(res.status).toHaveBeenCalledWith(206);

    // allowed header forwarded
    expect(res.setHeader).toHaveBeenCalledWith('content-type', 'text/event-stream');

    // blocked headers must NOT be forwarded via the forEach loop
    const setHeaderCalls = (res.setHeader as jest.Mock).mock.calls as [string, string][];
    const forwardedNames = setHeaderCalls.map(([name]) => name.toLowerCase());
    expect(forwardedNames).not.toContain('authorization');
    expect(forwardedNames).not.toContain('transfer-encoding');
  });

  it('non-OK upstream: logs error, sends error body text, does not set streaming headers', async () => {
    const errorText = jest.fn<Promise<string>, []>().mockResolvedValue('oops');
    const upstream = makeUpstream({ ok: false, status: 400, text: errorText });
    chatService.proxyChat.mockResolvedValue(upstream);

    const res = makeRes();
    await controller.chatCompletions(makeReq({}), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(errorText).toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith('oops');

    // streaming override headers must not have been set
    const setHeaderCalls = (res.setHeader as jest.Mock).mock.calls as [string, string][];
    const setNames = setHeaderCalls.map(([n]) => n);
    expect(setNames).not.toContain('Content-Encoding');
    expect(setNames).not.toContain('Cache-Control');
    expect(setNames).not.toContain('Connection');
  });

  it('OK but no body: sends upstream text()', async () => {
    const bodyText = jest.fn<Promise<string>, []>().mockResolvedValue('full-body');
    const upstream = makeUpstream({
      ok: true,
      status: 200,
      headerMap: {},
      text: bodyText,
      body: null,
    });
    chatService.proxyChat.mockResolvedValue(upstream);

    const res = makeRes();
    await controller.chatCompletions(makeReq({}), res);

    expect(bodyText).toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith('full-body');
  });

  it('OK with a body: sets streaming override headers and pipes node stream to res', async () => {
    const fakeNodeStream = { pipe: jest.fn(), on: jest.fn() };
    jest.spyOn(Readable, 'fromWeb').mockReturnValue(fakeNodeStream as any);

    const upstream = makeUpstream({
      ok: true,
      status: 200,
      headerMap: {},
      body: {} as unknown,
    });
    chatService.proxyChat.mockResolvedValue(upstream);

    const res = makeRes();
    await controller.chatCompletions(makeReq({}), res);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Encoding', 'none');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
    expect(fakeNodeStream.pipe).toHaveBeenCalledWith(res);
    expect(fakeNodeStream.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('stream error with headersSent=false: responds 500 JSON', async () => {
    const fakeNodeStream = { pipe: jest.fn(), on: jest.fn() };
    jest.spyOn(Readable, 'fromWeb').mockReturnValue(fakeNodeStream as any);

    const upstream = makeUpstream({ ok: true, status: 200, body: {} as unknown });
    chatService.proxyChat.mockResolvedValue(upstream);

    const res = makeRes(false);
    await controller.chatCompletions(makeReq({}), res);

    // extract the error handler registered via .on('error', handler)
    const onCalls = (fakeNodeStream.on as jest.Mock).mock.calls as [string, Function][];
    const [, errorHandler] = onCalls.find(([event]) => event === 'error')!;

    errorHandler(new Error('boom'));

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Proxy stream failed' });
  });

  it('stream error with headersSent=true: does not call res.status/json', async () => {
    const fakeNodeStream = { pipe: jest.fn(), on: jest.fn() };
    jest.spyOn(Readable, 'fromWeb').mockReturnValue(fakeNodeStream as any);

    const upstream = makeUpstream({ ok: true, status: 200, body: {} as unknown });
    chatService.proxyChat.mockResolvedValue(upstream);

    const res = makeRes(true);
    await controller.chatCompletions(makeReq({}), res);

    const onCalls = (fakeNodeStream.on as jest.Mock).mock.calls as [string, Function][];
    const [, errorHandler] = onCalls.find(([event]) => event === 'error')!;

    // Clear any prior calls from setup
    (res.status as jest.Mock).mockClear();
    (res.json as jest.Mock).mockClear();

    errorHandler(new Error('too late'));

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('proxyChat throws with headersSent=false: responds 502 JSON', async () => {
    chatService.proxyChat.mockRejectedValue(new Error('network error'));

    const res = makeRes(false);
    await controller.chatCompletions(makeReq({}), res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({ error: 'Upstream request failed' });
  });

  it('proxyChat throws with headersSent=true: does not call res.status/json', async () => {
    chatService.proxyChat.mockRejectedValue(new Error('network error'));

    const res = makeRes(true);
    await controller.chatCompletions(makeReq({}), res);

    // status may have been set earlier (it's not in this path), but 502 should NOT be called
    const statusCalls = (res.status as jest.Mock).mock.calls as [number][];
    expect(statusCalls.every(([code]) => code !== 502)).toBe(true);
    const jsonCalls = (res.json as jest.Mock).mock.calls as [unknown][];
    expect(
      jsonCalls.every((args) => {
        const obj = args[0] as Record<string, unknown>;
        return obj?.error !== 'Upstream request failed';
      }),
    ).toBe(true);
  });

  it('extractE2EEHeaders: string values forwarded with canonical casing; array values dropped', async () => {
    const fakeNodeStream = { pipe: jest.fn(), on: jest.fn() };
    jest.spyOn(Readable, 'fromWeb').mockReturnValue(fakeNodeStream as any);

    const upstream = makeUpstream({ ok: true, status: 200, body: {} as unknown });
    chatService.proxyChat.mockResolvedValue(upstream);

    const req = makeReq({}, {
      'x-signing-algo': 'ed',
      'x-client-pub-key': 'k',
      'x-model-pub-key': ['arr'],   // array — must be dropped
      'x-encryption-version': 'v2',
    });

    const res = makeRes();
    await controller.chatCompletions(req, res);

    expect(chatService.proxyChat).toHaveBeenCalledWith(
      expect.anything(),
      {
        'X-Signing-Algo': 'ed',
        'X-Client-Pub-Key': 'k',
        'X-Encryption-Version': 'v2',
        // X-Model-Pub-Key must be absent because the value was an array
      },
    );
    const headersArg = (chatService.proxyChat as jest.Mock).mock.calls[0][1] as Record<string, string>;
    expect(headersArg).not.toHaveProperty('X-Model-Pub-Key');
  });
});

// ---------------------------------------------------------------------------
// Batch endpoint — existing tests (unchanged) + new branch coverage
// ---------------------------------------------------------------------------

describe('CompletionsController (batch)', () => {
  let chatService: { proxyChat: jest.Mock };
  let queue: {
    canAccept: jest.Mock;
    snapshot: jest.Mock;
    run: jest.Mock;
  };
  let controller: CompletionsController;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    chatService = { proxyChat: jest.fn() };
    queue = {
      canAccept: jest.fn(),
      snapshot: jest.fn().mockReturnValue({ active: 0, waiting: 0 }),
      run: jest.fn((task: () => Promise<unknown>) => task()),
    };
    controller = new CompletionsController(
      chatService as unknown as ChatService,
      queue as unknown as InferenceQueueService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns 400 when `requests` is missing or empty', async () => {
    const res = makeRes();
    await controller.batchChatCompletions(makeReq({ requests: [] }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(chatService.proxyChat).not.toHaveBeenCalled();
  });

  it('returns 400 when the request body is undefined (no JSON parsed)', async () => {
    // Express 5 leaves req.body undefined for a POST whose content-type the
    // json/urlencoded parsers do not handle. The handler must degrade to a
    // clean 400, not throw a TypeError destructuring undefined.
    const res = makeRes();
    await controller.batchChatCompletions(makeReq(undefined), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(chatService.proxyChat).not.toHaveBeenCalled();
  });

  it('returns 400 when the request body is null', async () => {
    const res = makeRes();
    await controller.batchChatCompletions(makeReq(null), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(chatService.proxyChat).not.toHaveBeenCalled();
  });

  it('returns 400 when `requests` is present but not an array', async () => {
    const res = makeRes();
    await controller.batchChatCompletions(makeReq({ requests: 'nope' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(chatService.proxyChat).not.toHaveBeenCalled();
  });

  it('returns 503 when the queue cannot accept the batch', async () => {
    queue.canAccept.mockReturnValue(false);
    const res = makeRes();

    await controller.batchChatCompletions(makeReq({ requests: [{ model: 'm' }] }), res);

    expect(queue.canAccept).toHaveBeenCalledWith(1);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Inference queue full, retry later',
    });
    expect(chatService.proxyChat).not.toHaveBeenCalled();
  });

  it('processes the batch when the queue can accept it', async () => {
    queue.canAccept.mockReturnValue(true);
    chatService.proxyChat.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'c1', choices: [{ finish_reason: 'stop' }] }),
    });
    const res = makeRes();

    await controller.batchChatCompletions(makeReq({ requests: [{ model: 'm' }] }), res);

    expect(queue.run).toHaveBeenCalledTimes(1);
    expect(chatService.proxyChat).toHaveBeenCalledTimes(1);
    const payload = res.json.mock.calls[0][0] as {
      results: Array<{ index: number; response?: unknown }>;
    };
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0].index).toBe(0);
  });

  it('batch item with non-OK upstream returns error element with status code', async () => {
    queue.canAccept.mockReturnValue(true);
    chatService.proxyChat.mockResolvedValue(
      makeUpstream({
        ok: false,
        status: 429,
        text: jest.fn<Promise<string>, []>().mockResolvedValue('rl'),
      }),
    );
    const res = makeRes();

    await controller.batchChatCompletions(makeReq({ requests: [{ model: 'm' }] }), res);

    const payload = (res.json as jest.Mock).mock.calls[0][0] as {
      results: Array<{ index: number; error?: string }>;
    };
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0].index).toBe(0);
    expect(payload.results[0].error).toEqual(expect.stringContaining('Upstream error (429)'));
  });

  it('batch item where proxyChat throws returns { index, error: "Request failed" }', async () => {
    queue.canAccept.mockReturnValue(true);
    chatService.proxyChat.mockRejectedValue(new Error('timeout'));
    const res = makeRes();

    await controller.batchChatCompletions(makeReq({ requests: [{ model: 'm' }] }), res);

    const payload = (res.json as jest.Mock).mock.calls[0][0] as {
      results: Array<{ index: number; error?: string }>;
    };
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]).toEqual({ index: 0, error: 'Request failed' });
  });

  it('mixed batch: one OK and one throwing produce correct shapes in results', async () => {
    queue.canAccept.mockReturnValue(true);

    const okResponse = makeUpstream({
      ok: true,
      status: 200,
      json: jest.fn<Promise<unknown>, []>().mockResolvedValue({
        id: 'c1',
        choices: [
          {
            finish_reason: 'stop',
            message: { content: 'hi', tool_calls: [] },
          },
        ],
      }),
    });

    chatService.proxyChat
      .mockResolvedValueOnce(okResponse)
      .mockRejectedValueOnce(new Error('boom'));

    const res = makeRes();
    await controller.batchChatCompletions(
      makeReq({ requests: [{ model: 'm' }, { model: 'm2' }] }),
      res,
    );

    const payload = (res.json as jest.Mock).mock.calls[0][0] as {
      results: Array<{ index: number; response?: unknown; error?: string }>;
    };

    expect(payload.results).toHaveLength(2);

    const okResult = payload.results.find((r) => r.index === 0)!;
    expect(okResult.response).toEqual({
      id: 'c1',
      choices: [
        {
          finish_reason: 'stop',
          message: { content: 'hi', tool_calls: [] },
        },
      ],
    });
    expect(okResult.error).toBeUndefined();

    const errResult = payload.results.find((r) => r.index === 1)!;
    expect(errResult.error).toBe('Request failed');
    expect(errResult.response).toBeUndefined();
  });
});
