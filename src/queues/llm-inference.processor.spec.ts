import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { LlmInferenceProcessor } from './llm-inference.processor';

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

// Minimal lean InferenceJob document shape used across tests.
function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    requests: [{ id: 'r0', body: { messages: [{ role: 'user', content: 'x' }] } }],
    e2eeSession: null,
    sharedSystem: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Model mock factory — returns a fresh instance for each test so mocks are
// independent across tests.
// ---------------------------------------------------------------------------

function makeModelMock(doc: unknown) {
  const updateOneExec = jest.fn().mockResolvedValue({});
  const findByIdExec = jest.fn().mockResolvedValue(doc);

  const modelMock = {
    findById: jest.fn().mockReturnValue({
      lean: () => ({ exec: findByIdExec }),
    }),
    updateOne: jest.fn().mockReturnValue({ exec: updateOneExec }),
    _findByIdExec: findByIdExec,
    _updateOneExec: updateOneExec,
  };

  return modelMock;
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
  // 1. doc not found
  // -------------------------------------------------------------------------

  it('rejects with "not found" when the document does not exist', async () => {
    const modelMock = makeModelMock(null);
    const processor = new LlmInferenceProcessor(
      chatMock as never,
      modelMock as never,
    );
    const jobId = new Types.ObjectId().toString();
    const job = makeJob(jobId, 0);

    await expect(processor.process(job as never)).rejects.toThrow(/not found/);
    expect(chatMock.proxyChat).not.toHaveBeenCalled();
    expect(modelMock.updateOne).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. request index out of bounds
  // -------------------------------------------------------------------------

  it('rejects with "has no request at index" when requestIndex is out of bounds', async () => {
    const modelMock = makeModelMock(makeDoc());
    const processor = new LlmInferenceProcessor(
      chatMock as never,
      modelMock as never,
    );
    const jobId = new Types.ObjectId().toString();
    // requests has 1 entry (index 0); request index 99 is missing.
    const job = makeJob(jobId, 99);

    await expect(processor.process(job as never)).rejects.toThrow(
      /has no request at index/,
    );
    expect(chatMock.proxyChat).not.toHaveBeenCalled();
    expect(modelMock.updateOne).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3. SUCCESS path
  // -------------------------------------------------------------------------

  it('returns { id, ok:true } and writes the result to Mongo on success', async () => {
    const jsonResponse = { choices: [] };
    const upstream = makeResponse({ ok: true, jsonValue: jsonResponse });
    chatMock.proxyChat.mockResolvedValue(upstream);

    const modelMock = makeModelMock(makeDoc());
    const processor = new LlmInferenceProcessor(
      chatMock as never,
      modelMock as never,
    );
    const jobId = new Types.ObjectId().toString();
    const job = makeJob(jobId, 0);

    const result = await processor.process(job as never);

    // Return value
    expect(result).toEqual({ id: 'r0', ok: true });

    // proxyChat called with the forwarded body and an empty headers object
    expect(chatMock.proxyChat).toHaveBeenCalledTimes(1);
    const [calledBody, calledHeaders] = chatMock.proxyChat.mock.calls[0] as [
      unknown,
      unknown,
    ];
    expect(calledBody).toEqual({
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(calledHeaders).toEqual({});

    // updateOne called with correct filter and update
    expect(modelMock.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = modelMock.updateOne.mock.calls[0] as [
      { _id: Types.ObjectId },
      {
        $push: { results: { id: string; ok: boolean; response: unknown } };
        $set: { status: string };
      },
    ];
    expect(filter._id).toBeInstanceOf(Types.ObjectId);
    expect(filter._id.toString()).toBe(jobId);
    expect(update.$push.results).toEqual({
      id: 'r0',
      ok: true,
      response: jsonResponse,
    });
    expect(update.$set.status).toBe('processing');
  });

  // -------------------------------------------------------------------------
  // 4. UPSTREAM NOT OK (non-2xx response)
  // -------------------------------------------------------------------------

  it('pushes ok:false result and returns ok:false when upstream is not ok', async () => {
    const upstream = makeResponse({ ok: false, status: 500, textValue: 'err body' });
    chatMock.proxyChat.mockResolvedValue(upstream);

    const modelMock = makeModelMock(makeDoc());
    const processor = new LlmInferenceProcessor(
      chatMock as never,
      modelMock as never,
    );
    const jobId = new Types.ObjectId().toString();
    const job = makeJob(jobId, 0);

    const result = await processor.process(job as never);

    // Logger.warn must have been called
    expect(Logger.prototype.warn).toHaveBeenCalled();

    // Return value
    expect(result).toEqual({ id: 'r0', ok: false });

    // updateOne result shape
    const [, update] = modelMock.updateOne.mock.calls[0] as [
      unknown,
      { $push: { results: { id: string; ok: boolean; error: string } } },
    ];
    expect(update.$push.results).toEqual({
      id: 'r0',
      ok: false,
      error: 'upstream 500',
    });
  });

  // -------------------------------------------------------------------------
  // 5a. proxyChat THROWS an Error instance
  // -------------------------------------------------------------------------

  it('pushes ok:false with err.message and returns ok:false when proxyChat throws an Error', async () => {
    chatMock.proxyChat.mockRejectedValue(new Error('boom'));

    const modelMock = makeModelMock(makeDoc());
    const processor = new LlmInferenceProcessor(
      chatMock as never,
      modelMock as never,
    );
    const jobId = new Types.ObjectId().toString();
    const job = makeJob(jobId, 0);

    const result = await processor.process(job as never);

    expect(result).toEqual({ id: 'r0', ok: false });

    const [, update] = modelMock.updateOne.mock.calls[0] as [
      unknown,
      { $push: { results: { id: string; ok: boolean; error: string } } },
    ];
    expect(update.$push.results).toEqual({ id: 'r0', ok: false, error: 'boom' });
  });

  // -------------------------------------------------------------------------
  // 5b. proxyChat THROWS a non-Error (String coercion)
  // -------------------------------------------------------------------------

  it('pushes ok:false with String(err) when proxyChat throws a non-Error value', async () => {
    chatMock.proxyChat.mockRejectedValue('weird');

    const modelMock = makeModelMock(makeDoc());
    const processor = new LlmInferenceProcessor(
      chatMock as never,
      modelMock as never,
    );
    const jobId = new Types.ObjectId().toString();
    const job = makeJob(jobId, 0);

    const result = await processor.process(job as never);

    expect(result).toEqual({ id: 'r0', ok: false });

    const [, update] = modelMock.updateOne.mock.calls[0] as [
      unknown,
      { $push: { results: { id: string; ok: boolean; error: string } } },
    ];
    expect(update.$push.results).toEqual({ id: 'r0', ok: false, error: 'weird' });
  });

  // -------------------------------------------------------------------------
  // 6. E2EE HEADERS — only string values forwarded
  // -------------------------------------------------------------------------

  it('forwards only string-valued e2eeSession headers to proxyChat', async () => {
    const upstream = makeResponse({ ok: true, jsonValue: { choices: [] } });
    chatMock.proxyChat.mockResolvedValue(upstream);

    const e2eeSession = {
      'X-Signing-Algo': 'ed25519',
      'X-Bad': 123, // number — must be dropped
    };
    const modelMock = makeModelMock(makeDoc({ e2eeSession }));
    const processor = new LlmInferenceProcessor(
      chatMock as never,
      modelMock as never,
    );
    const jobId = new Types.ObjectId().toString();
    const job = makeJob(jobId, 0);

    await processor.process(job as never);

    const [, calledHeaders] = chatMock.proxyChat.mock.calls[0] as [
      unknown,
      Record<string, string>,
    ];
    expect(calledHeaders).toEqual({ 'X-Signing-Algo': 'ed25519' });
    expect(calledHeaders).not.toHaveProperty('X-Bad');
  });

  it('passes an empty headers object when e2eeSession is null', async () => {
    const upstream = makeResponse({ ok: true, jsonValue: { choices: [] } });
    chatMock.proxyChat.mockResolvedValue(upstream);

    const modelMock = makeModelMock(makeDoc({ e2eeSession: null }));
    const processor = new LlmInferenceProcessor(
      chatMock as never,
      modelMock as never,
    );
    const jobId = new Types.ObjectId().toString();
    const job = makeJob(jobId, 0);

    await processor.process(job as never);

    const [, calledHeaders] = chatMock.proxyChat.mock.calls[0] as [
      unknown,
      Record<string, string>,
    ];
    expect(calledHeaders).toEqual({});
  });

  // -------------------------------------------------------------------------
  // 7. SHARED SYSTEM — prepend behaviour
  // -------------------------------------------------------------------------

  it('prepends sharedSystem as system message and does NOT mutate the original body', async () => {
    const upstream = makeResponse({ ok: true, jsonValue: { choices: [] } });
    chatMock.proxyChat.mockResolvedValue(upstream);

    const originalMessages = [{ role: 'user', content: 'x' }];
    const doc = makeDoc({
      requests: [{ id: 'r0', body: { messages: originalMessages } }],
      sharedSystem: 'CIPHER',
    });
    const modelMock = makeModelMock(doc);
    const processor = new LlmInferenceProcessor(
      chatMock as never,
      modelMock as never,
    );
    const jobId = new Types.ObjectId().toString();
    const job = makeJob(jobId, 0);

    await processor.process(job as never);

    const [calledBody] = chatMock.proxyChat.mock.calls[0] as [
      { messages: Array<{ role: string; content: unknown }> },
      unknown,
    ];

    // System message prepended
    expect(calledBody.messages[0]).toEqual({ role: 'system', content: 'CIPHER' });
    // Original user message is still present after the system entry
    expect(calledBody.messages[1]).toEqual({ role: 'user', content: 'x' });
    expect(calledBody.messages).toHaveLength(2);

    // Original doc body must NOT be mutated
    expect(originalMessages).toHaveLength(1);
    expect(originalMessages[0].role).toBe('user');
  });

  it('passes body by same reference when sharedSystem is null', async () => {
    const upstream = makeResponse({ ok: true, jsonValue: { choices: [] } });
    chatMock.proxyChat.mockResolvedValue(upstream);

    const originalBody = { messages: [{ role: 'user', content: 'x' }] };
    const doc = makeDoc({
      requests: [{ id: 'r0', body: originalBody }],
      sharedSystem: null,
    });
    const modelMock = makeModelMock(doc);
    const processor = new LlmInferenceProcessor(
      chatMock as never,
      modelMock as never,
    );
    const jobId = new Types.ObjectId().toString();
    const job = makeJob(jobId, 0);

    await processor.process(job as never);

    const [calledBody] = chatMock.proxyChat.mock.calls[0] as [unknown, unknown];
    // Same reference — no cloning when sharedSystem is absent
    expect(calledBody).toBe(originalBody);
  });

  it('passes body unchanged when sharedSystem is set but body.messages is not an array', async () => {
    const upstream = makeResponse({ ok: true, jsonValue: { choices: [] } });
    chatMock.proxyChat.mockResolvedValue(upstream);

    const originalBody = { prompt: 'x' }; // no messages array
    const doc = makeDoc({
      requests: [{ id: 'r0', body: originalBody }],
      sharedSystem: 'CIPHER',
    });
    const modelMock = makeModelMock(doc);
    const processor = new LlmInferenceProcessor(
      chatMock as never,
      modelMock as never,
    );
    const jobId = new Types.ObjectId().toString();
    const job = makeJob(jobId, 0);

    await processor.process(job as never);

    const [calledBody] = chatMock.proxyChat.mock.calls[0] as [unknown, unknown];
    // Same reference — maybePrependSharedSystem returns body untouched
    expect(calledBody).toBe(originalBody);
  });
});
