import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { LlmInferenceProcessor } from './llm-inference.processor';
import type { RequestContext } from '../inference-jobs/job-store.port';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(opts: {
  ok: boolean;
  status?: number;
  textValue?: string;
  jsonValue?: unknown;
}): { ok: boolean; status: number; text: jest.Mock; json: jest.Mock } {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    text: jest.fn().mockResolvedValue(opts.textValue ?? ''),
    json: jest.fn().mockResolvedValue(opts.jsonValue ?? {}),
  };
}

type FakeJob = { data: { jobId: string; requestIndex: number } };

function makeJob(jobId: string, requestIndex: number): FakeJob {
  return { data: { jobId, requestIndex } };
}

// Minimal RequestContext shape used across tests.
function makeContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    request: { id: 'r0', body: { messages: [{ role: 'user', content: 'x' }] } },
    e2eeSession: null,
    sharedSystem: null,
    ...overrides,
  };
}

function makeStoreMock(context: RequestContext | null) {
  return {
    getRequestContext: jest.fn().mockResolvedValue(context),
    appendResult: jest.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('LlmInferenceProcessor', () => {
  let chatMock: { proxyChat: jest.Mock };

  beforeEach(() => {
    chatMock = { proxyChat: jest.fn() };
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. missing context (unknown job OR out-of-bounds index — the store
  //    returns null for both)
  // -------------------------------------------------------------------------

  it('rejects when the store has no request for the (jobId, index)', async () => {
    const storeMock = makeStoreMock(null);
    const processor = new LlmInferenceProcessor(chatMock as never, storeMock as never);
    const jobId = new Types.ObjectId().toString();
    const job = makeJob(jobId, 99);

    await expect(processor.process(job as never)).rejects.toThrow(/has no request at index/);
    expect(chatMock.proxyChat).not.toHaveBeenCalled();
    expect(storeMock.appendResult).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. SUCCESS path
  // -------------------------------------------------------------------------

  it('returns { id, ok:true } and appends the result to the store on success', async () => {
    const jsonResponse = { choices: [] };
    const upstream = makeResponse({ ok: true, jsonValue: jsonResponse });
    chatMock.proxyChat.mockResolvedValue(upstream);

    const storeMock = makeStoreMock(makeContext());
    const processor = new LlmInferenceProcessor(chatMock as never, storeMock as never);
    const jobId = new Types.ObjectId().toString();
    const job = makeJob(jobId, 0);

    const result = await processor.process(job as never);

    // Return value
    expect(result).toEqual({ id: 'r0', ok: true });

    // proxyChat called with the forwarded body and an empty headers object
    expect(chatMock.proxyChat).toHaveBeenCalledTimes(1);
    const [calledBody, calledHeaders] = chatMock.proxyChat.mock.calls[0] as [unknown, unknown];
    expect(calledBody).toEqual({
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(calledHeaders).toEqual({});

    // appendResult called with the jobId, index, and a fully-normalized result
    expect(storeMock.appendResult).toHaveBeenCalledTimes(1);
    expect(storeMock.appendResult).toHaveBeenCalledWith(jobId, 0, {
      id: 'r0',
      ok: true,
      response: jsonResponse,
      error: null,
    });
  });

  // -------------------------------------------------------------------------
  // 3. UPSTREAM NOT OK (non-2xx response)
  // -------------------------------------------------------------------------

  it('appends ok:false result and returns ok:false when upstream is not ok', async () => {
    const upstream = makeResponse({ ok: false, status: 500, textValue: 'err body' });
    chatMock.proxyChat.mockResolvedValue(upstream);

    const storeMock = makeStoreMock(makeContext());
    const processor = new LlmInferenceProcessor(chatMock as never, storeMock as never);
    const jobId = new Types.ObjectId().toString();
    const job = makeJob(jobId, 0);

    const result = await processor.process(job as never);

    // Logger.warn must have been called
    expect(Logger.prototype.warn).toHaveBeenCalled();

    // Return value
    expect(result).toEqual({ id: 'r0', ok: false });

    expect(storeMock.appendResult).toHaveBeenCalledWith(jobId, 0, {
      id: 'r0',
      ok: false,
      response: null,
      error: 'upstream 500',
    });
  });

  // -------------------------------------------------------------------------
  // 4a. proxyChat THROWS an Error instance
  // -------------------------------------------------------------------------

  it('appends ok:false with err.message and returns ok:false when proxyChat throws an Error', async () => {
    chatMock.proxyChat.mockRejectedValue(new Error('boom'));

    const storeMock = makeStoreMock(makeContext());
    const processor = new LlmInferenceProcessor(chatMock as never, storeMock as never);
    const jobId = new Types.ObjectId().toString();
    const job = makeJob(jobId, 0);

    const result = await processor.process(job as never);

    expect(result).toEqual({ id: 'r0', ok: false });
    expect(storeMock.appendResult).toHaveBeenCalledWith(jobId, 0, {
      id: 'r0',
      ok: false,
      response: null,
      error: 'boom',
    });
  });

  // -------------------------------------------------------------------------
  // 4b. proxyChat THROWS a non-Error (String coercion)
  // -------------------------------------------------------------------------

  it('appends ok:false with String(err) when proxyChat throws a non-Error value', async () => {
    chatMock.proxyChat.mockRejectedValue('weird');

    const storeMock = makeStoreMock(makeContext());
    const processor = new LlmInferenceProcessor(chatMock as never, storeMock as never);
    const jobId = new Types.ObjectId().toString();
    const job = makeJob(jobId, 0);

    const result = await processor.process(job as never);

    expect(result).toEqual({ id: 'r0', ok: false });
    expect(storeMock.appendResult).toHaveBeenCalledWith(jobId, 0, {
      id: 'r0',
      ok: false,
      response: null,
      error: 'weird',
    });
  });

  // -------------------------------------------------------------------------
  // 5. E2EE HEADERS — forwarded verbatim from the store's (already string-
  //    filtered) session record
  // -------------------------------------------------------------------------

  it('forwards the e2eeSession record as upstream headers', async () => {
    const upstream = makeResponse({ ok: true, jsonValue: { choices: [] } });
    chatMock.proxyChat.mockResolvedValue(upstream);

    const storeMock = makeStoreMock(makeContext({ e2eeSession: { 'X-Signing-Algo': 'ed25519' } }));
    const processor = new LlmInferenceProcessor(chatMock as never, storeMock as never);
    const jobId = new Types.ObjectId().toString();

    await processor.process(makeJob(jobId, 0) as never);

    const [, calledHeaders] = chatMock.proxyChat.mock.calls[0] as [unknown, Record<string, string>];
    expect(calledHeaders).toEqual({ 'X-Signing-Algo': 'ed25519' });
  });

  it('passes an empty headers object when e2eeSession is null', async () => {
    const upstream = makeResponse({ ok: true, jsonValue: { choices: [] } });
    chatMock.proxyChat.mockResolvedValue(upstream);

    const storeMock = makeStoreMock(makeContext({ e2eeSession: null }));
    const processor = new LlmInferenceProcessor(chatMock as never, storeMock as never);
    const jobId = new Types.ObjectId().toString();

    await processor.process(makeJob(jobId, 0) as never);

    const [, calledHeaders] = chatMock.proxyChat.mock.calls[0] as [unknown, Record<string, string>];
    expect(calledHeaders).toEqual({});
  });

  // -------------------------------------------------------------------------
  // 6. SHARED SYSTEM — prepend behaviour
  // -------------------------------------------------------------------------

  it('prepends sharedSystem as system message and does NOT mutate the original body', async () => {
    const upstream = makeResponse({ ok: true, jsonValue: { choices: [] } });
    chatMock.proxyChat.mockResolvedValue(upstream);

    const originalMessages = [{ role: 'user', content: 'x' }];
    const storeMock = makeStoreMock(
      makeContext({
        request: { id: 'r0', body: { messages: originalMessages } },
        sharedSystem: 'CIPHER',
      }),
    );
    const processor = new LlmInferenceProcessor(chatMock as never, storeMock as never);
    const jobId = new Types.ObjectId().toString();

    await processor.process(makeJob(jobId, 0) as never);

    const [calledBody] = chatMock.proxyChat.mock.calls[0] as [
      { messages: Array<{ role: string; content: unknown }> },
      unknown,
    ];

    // System message prepended
    expect(calledBody.messages[0]).toEqual({ role: 'system', content: 'CIPHER' });
    // Original user message is still present after the system entry
    expect(calledBody.messages[1]).toEqual({ role: 'user', content: 'x' });
    expect(calledBody.messages).toHaveLength(2);

    // Original body must NOT be mutated
    expect(originalMessages).toHaveLength(1);
    expect(originalMessages[0].role).toBe('user');
  });

  it('passes body by same reference when sharedSystem is null', async () => {
    const upstream = makeResponse({ ok: true, jsonValue: { choices: [] } });
    chatMock.proxyChat.mockResolvedValue(upstream);

    const originalBody = { messages: [{ role: 'user', content: 'x' }] };
    const storeMock = makeStoreMock(
      makeContext({ request: { id: 'r0', body: originalBody }, sharedSystem: null }),
    );
    const processor = new LlmInferenceProcessor(chatMock as never, storeMock as never);
    const jobId = new Types.ObjectId().toString();

    await processor.process(makeJob(jobId, 0) as never);

    const [calledBody] = chatMock.proxyChat.mock.calls[0] as [unknown, unknown];
    // Same reference — no cloning when sharedSystem is absent
    expect(calledBody).toBe(originalBody);
  });

  it('passes body unchanged when sharedSystem is set but body.messages is not an array', async () => {
    const upstream = makeResponse({ ok: true, jsonValue: { choices: [] } });
    chatMock.proxyChat.mockResolvedValue(upstream);

    const originalBody = { prompt: 'x' }; // no messages array
    const storeMock = makeStoreMock(
      makeContext({ request: { id: 'r0', body: originalBody }, sharedSystem: 'CIPHER' }),
    );
    const processor = new LlmInferenceProcessor(chatMock as never, storeMock as never);
    const jobId = new Types.ObjectId().toString();

    await processor.process(makeJob(jobId, 0) as never);

    const [calledBody] = chatMock.proxyChat.mock.calls[0] as [unknown, unknown];
    // Same reference — maybePrependSharedSystem returns body untouched
    expect(calledBody).toBe(originalBody);
  });

  it('passes body by same reference when sharedSystem is an empty string', async () => {
    const upstream = makeResponse({ ok: true, jsonValue: { choices: [] } });
    chatMock.proxyChat.mockResolvedValue(upstream);

    const originalBody = { messages: [{ role: 'user', content: 'x' }] };
    const storeMock = makeStoreMock(
      makeContext({
        request: { id: 'r0', body: originalBody },
        sharedSystem: '', // falsy — the `!sharedSystem` guard must short-circuit
      }),
    );
    const processor = new LlmInferenceProcessor(chatMock as never, storeMock as never);
    const jobId = new Types.ObjectId().toString();

    await processor.process(makeJob(jobId, 0) as never);

    const [calledBody] = chatMock.proxyChat.mock.calls[0] as [unknown, unknown];
    expect(calledBody).toBe(originalBody);
  });

  it('prepends sharedSystem onto an empty messages array', async () => {
    const upstream = makeResponse({ ok: true, jsonValue: { choices: [] } });
    chatMock.proxyChat.mockResolvedValue(upstream);

    const originalMessages: Array<{ role: string; content: unknown }> = [];
    const storeMock = makeStoreMock(
      makeContext({
        request: { id: 'r0', body: { messages: originalMessages } },
        sharedSystem: 'CIPHER',
      }),
    );
    const processor = new LlmInferenceProcessor(chatMock as never, storeMock as never);
    const jobId = new Types.ObjectId().toString();

    await processor.process(makeJob(jobId, 0) as never);

    const [calledBody] = chatMock.proxyChat.mock.calls[0] as [
      { messages: Array<{ role: string; content: unknown }> },
      unknown,
    ];
    expect(calledBody.messages).toEqual([{ role: 'system', content: 'CIPHER' }]);
    // original empty array is untouched
    expect(originalMessages).toHaveLength(0);
  });
});
