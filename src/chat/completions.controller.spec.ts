import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { Readable } from 'stream';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { ChatService, DeadlineElapsedError } from './chat.service';
import { CompletionsController } from './completions.controller';
import { InferenceQueueService } from './inference-queue.service';

/** Minimal EventEmitter-ish recorder so tests can fire 'close' by hand. */
function makeEmitter() {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(cb);
    }),
    off: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
      handlers.get(event)?.delete(cb);
    }),
    emit: (event: string) => handlers.get(event)?.forEach((cb) => cb()),
  };
}

type MockRes = Response & {
  status: jest.Mock;
  json: jest.Mock;
  send: jest.Mock;
  setHeader: jest.Mock;
  headersSent: boolean;
  writableEnded: boolean;
  emit: (event: string) => void;
};

function makeRes(headersSent = false): MockRes {
  const emitter = makeEmitter();
  const res: Record<string, unknown> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn().mockReturnValue(res);
  res.headersSent = headersSent;
  // Express default: the response has not been ended yet. A test that fires
  // 'close' with this false is simulating a real client disconnect.
  res.writableEnded = false;
  res.on = emitter.on;
  res.off = emitter.off;
  res.emit = emitter.emit;
  return res as unknown as MockRes;
}

type MockReq = AuthenticatedRequest & { emit: (event: string) => void; complete: boolean };

function makeReq(body: unknown, headers: Record<string, string | string[]> = {}): MockReq {
  const emitter = makeEmitter();
  return {
    body,
    headers,
    user: { id: 'user-1', subscriptionIsActive: true },
    // Node sets `complete` once the message parsed cleanly; the controller
    // relies on it to tell a normal early req-'close' from a real abort.
    complete: true,
    on: emitter.on,
    off: emitter.off,
    emit: emitter.emit,
  } as unknown as MockReq;
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
  const chatService = { proxyChat: jest.fn(), createDeadline: jest.fn(() => Date.now() + 120_000) };
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
  let chatService: { proxyChat: jest.Mock; createDeadline: jest.Mock };
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
        authorization: 'secret',
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

  it('destroys the upstream stream when the client disconnects mid-stream', async () => {
    // The abort bridge inside ChatService is detached once upstream headers
    // arrive, so a disconnect AFTER that point can only be propagated here.
    const fakeNodeStream = { pipe: jest.fn(), on: jest.fn(), destroy: jest.fn() };
    jest.spyOn(Readable, 'fromWeb').mockReturnValue(fakeNodeStream as any);

    const upstream = makeUpstream({ ok: true, status: 200, body: {} as unknown });
    chatService.proxyChat.mockResolvedValue(upstream);

    const res = makeRes();
    await controller.chatCompletions(makeReq({}), res);

    expect(fakeNodeStream.destroy).not.toHaveBeenCalled();

    // Client walks away: res closes without the response having ended.
    res.emit('close');

    expect(fakeNodeStream.destroy).toHaveBeenCalled();
  });

  it('does not destroy the stream when the response finishes normally', async () => {
    const fakeNodeStream = { pipe: jest.fn(), on: jest.fn(), destroy: jest.fn() };
    jest.spyOn(Readable, 'fromWeb').mockReturnValue(fakeNodeStream as any);

    const upstream = makeUpstream({ ok: true, status: 200, body: {} as unknown });
    chatService.proxyChat.mockResolvedValue(upstream);

    const res = makeRes();
    await controller.chatCompletions(makeReq({}), res);

    (res as unknown as { writableEnded: boolean }).writableEnded = true;
    res.emit('close');

    expect(fakeNodeStream.destroy).not.toHaveBeenCalled();
  });

  it('stream error with headersSent=false: responds 500 JSON', async () => {
    const fakeNodeStream = { pipe: jest.fn(), on: jest.fn() };
    jest.spyOn(Readable, 'fromWeb').mockReturnValue(fakeNodeStream as any);

    const upstream = makeUpstream({ ok: true, status: 200, body: {} as unknown });
    chatService.proxyChat.mockResolvedValue(upstream);

    const res = makeRes(false);
    await controller.chatCompletions(makeReq({}), res);

    // extract the error handler registered via .on('error', handler)
    const onCalls = fakeNodeStream.on.mock.calls as [string, (err: Error) => void][];
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

    const onCalls = fakeNodeStream.on.mock.calls as [string, (err: Error) => void][];
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

    const req = makeReq(
      {},
      {
        'x-signing-algo': 'ed',
        'x-client-pub-key': 'k',
        'x-model-pub-key': ['arr'], // array — must be dropped
        'x-encryption-version': 'v2',
      },
    );

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
      expect.objectContaining({ deadlineAt: expect.any(Number) }),
    );
    const headersArg = chatService.proxyChat.mock.calls[0][1] as Record<string, string>;
    expect(headersArg).not.toHaveProperty('X-Model-Pub-Key');
  });
});

// ---------------------------------------------------------------------------
// Batch endpoint — existing tests (unchanged) + new branch coverage
// ---------------------------------------------------------------------------

describe('CompletionsController (batch)', () => {
  let chatService: { proxyChat: jest.Mock; createDeadline: jest.Mock };
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

    chatService = { proxyChat: jest.fn(), createDeadline: jest.fn(() => Date.now() + 120_000) };
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

  it('reports a deadline-elapsed item distinguishably from a generic failure', async () => {
    queue.canAccept.mockReturnValue(true);
    chatService.proxyChat.mockRejectedValue(new DeadlineElapsedError('deadline elapsed in queue'));
    const res = makeRes();

    await controller.batchChatCompletions(makeReq({ requests: [{ model: 'm' }] }), res);

    const payload = (res.json as jest.Mock).mock.calls[0][0] as {
      results: Array<{ index: number; error?: string }>;
    };
    expect(payload.results[0].error).toBe('Request failed (deadline elapsed in queue)');
  });

  it('passes a deadline and the client signal to every batch item', async () => {
    queue.canAccept.mockReturnValue(true);
    chatService.proxyChat.mockResolvedValue(
      makeUpstream({ ok: true, status: 200, json: async () => ({ id: 'c' }) }),
    );
    const res = makeRes();

    await controller.batchChatCompletions(
      makeReq({ requests: [{ model: 'a' }, { model: 'b' }] }),
      res,
    );

    expect(chatService.proxyChat).toHaveBeenCalledTimes(2);
    for (const call of chatService.proxyChat.mock.calls) {
      const opts = call[2] as { deadlineAt: number; signal: AbortSignal; userId: string };
      expect(typeof opts.deadlineAt).toBe('number');
      expect(opts.signal).toBeInstanceOf(AbortSignal);
      expect(opts.userId).toBe('user-1');
    }
  });
});

// ---------------------------------------------------------------------------
// C.1 / C.2 — deadline stamped at entry, and client disconnect frees the slot.
// These use a REAL InferenceQueueService: with the mock queue, `snapshot()` is
// a constant and would "pass" against no implementation at all.
// ---------------------------------------------------------------------------

describe('CompletionsController (deadline + client disconnect, real queue)', () => {
  let chatService: { proxyChat: jest.Mock; createDeadline: jest.Mock };
  let queue: InferenceQueueService;
  let controller: CompletionsController;

  function makeQueueConfig(values: Record<string, unknown>): ConfigService {
    return {
      get: <T>(key: string, fallback?: T): T => (values[key] as T) ?? (fallback as T),
    } as unknown as ConfigService;
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    chatService = { proxyChat: jest.fn(), createDeadline: jest.fn(() => Date.now() + 120_000) };
    // Real limiter, serialized to one slot so item 2 must wait for item 1.
    queue = new InferenceQueueService(
      makeQueueConfig({ INFERENCE_MAX_CONCURRENCY: 1, INFERENCE_MAX_QUEUE_DEPTH: 200 }),
    );
    controller = new CompletionsController(chatService as unknown as ChatService, queue);
  });

  afterEach(() => jest.restoreAllMocks());

  it('stamps each item deadline at request entry, not at slot acquisition', async () => {
    const deadlines: number[] = [];
    const dispatchedAt: number[] = [];
    chatService.proxyChat.mockImplementation(
      async (_body: unknown, _h: unknown, opts: { deadlineAt: number }) => {
        deadlines.push(opts.deadlineAt);
        dispatchedAt.push(Date.now());
        // Occupy the single slot long enough that item 2 demonstrably queued.
        await new Promise((r) => setTimeout(r, 40));
        return makeUpstream({ ok: true, status: 200, json: async () => ({ id: 'c' }) });
      },
    );

    const res = makeRes();
    await controller.batchChatCompletions(
      makeReq({ requests: [{ model: 'a' }, { model: 'b' }] }),
      res,
    );

    // Item 2 really did wait for the slot...
    expect(dispatchedAt[1] - dispatchedAt[0]).toBeGreaterThanOrEqual(30);
    // ...yet its deadline was stamped with item 1's, at request entry. If the
    // stamp moved inside queue.run, this gap would grow with the wait.
    expect(Math.abs(deadlines[1] - deadlines[0])).toBeLessThan(10);
  });

  it('aborts the upstream fetch and releases the queue slot when the client disconnects', async () => {
    let sawSignal: AbortSignal | undefined;
    chatService.proxyChat.mockImplementation(
      (_body: unknown, _h: unknown, opts: { signal: AbortSignal }) => {
        sawSignal = opts.signal;
        // Mimic ChatService: settle only when the fetch is aborted.
        return new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        });
      },
    );

    const req = makeReq({ requests: [{ model: 'a' }] });
    const res = makeRes();
    const pending = controller.batchChatCompletions(req, res);

    // Slot is held while the (never-settling) upstream call is in flight.
    await new Promise((r) => setImmediate(r));
    expect(queue.snapshot().active).toBe(1);

    // Client goes away mid-flight: res closes without the response ending.
    res.emit('close');

    await pending;

    expect(sawSignal?.aborted).toBe(true);
    expect(queue.snapshot()).toEqual({ active: 0, waiting: 0 });
  });

  it('does NOT abort on the normal early req "close" that Node emits once the body is parsed', async () => {
    // Measured on Node 20+: req 'close' fires ~1ms into a healthy request,
    // with res.writableEnded still false. Guarding on req.complete is what
    // keeps this from aborting every single request.
    let sawSignal: AbortSignal | undefined;
    chatService.proxyChat.mockImplementation(
      async (_body: unknown, _h: unknown, opts: { signal: AbortSignal }) => {
        sawSignal = opts.signal;
        return makeUpstream({ ok: true, status: 200, json: async () => ({ id: 'c' }) });
      },
    );

    const req = makeReq({ requests: [{ model: 'a' }] });
    const res = makeRes();
    const pending = controller.batchChatCompletions(req, res);

    req.emit('close'); // complete === true → healthy request
    await pending;

    expect(sawSignal?.aborted).toBe(false);
    const payload = (res.json as jest.Mock).mock.calls[0][0] as { results: unknown[] };
    expect(payload.results).toHaveLength(1);
  });

  it('aborts when the request itself was cut short (req.complete false)', async () => {
    let sawSignal: AbortSignal | undefined;
    chatService.proxyChat.mockImplementation(
      (_body: unknown, _h: unknown, opts: { signal: AbortSignal }) => {
        sawSignal = opts.signal;
        return new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        });
      },
    );

    const req = makeReq({ requests: [{ model: 'a' }] });
    const res = makeRes();
    const pending = controller.batchChatCompletions(req, res);
    await new Promise((r) => setImmediate(r));

    (req as unknown as { complete: boolean }).complete = false;
    req.emit('close');
    await pending;

    expect(sawSignal?.aborted).toBe(true);
    expect(queue.snapshot().active).toBe(0);
  });

  it('streaming route: passes a deadline and client signal to proxyChat', async () => {
    chatService.proxyChat.mockResolvedValue(
      makeUpstream({ ok: true, status: 200, text: async () => 'body', body: null }),
    );

    await controller.chatCompletions(makeReq({}), makeRes());

    const opts = chatService.proxyChat.mock.calls[0][2] as {
      deadlineAt: number;
      signal: AbortSignal;
      userId: string;
    };
    expect(opts.deadlineAt).toBeGreaterThan(Date.now() - 1);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.userId).toBe('user-1');
  });

  it('streaming route: a deadline-elapsed rejection still answers 502', async () => {
    chatService.proxyChat.mockRejectedValue(new DeadlineElapsedError('deadline elapsed in queue'));

    const res = makeRes();
    await controller.chatCompletions(makeReq({}), res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({ error: 'Upstream request failed' });
  });
});
