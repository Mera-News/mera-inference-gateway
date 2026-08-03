import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UPSTREAM_BASE_URL } from '../constants';
import { ChatService, DeadlineElapsedError } from './chat.service';

function makeConfig(values: Record<string, unknown>): ConfigService {
  return {
    get: <T>(key: string, fallback?: T): T => (values[key] as T) ?? (fallback as T),
  } as unknown as ConfigService;
}

describe('ChatService', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('throws at construction when NEAR_AI_API_KEY is missing', () => {
    expect(() => new ChatService(makeConfig({}))).toThrow(/NEAR_AI_API_KEY/);
  });

  it('defaults UPSTREAM_TIMEOUT_MS to 120_000 (tolerates a cold NEAR model)', () => {
    const config = makeConfig({ NEAR_AI_API_KEY: 'k' });
    const getSpy = jest.spyOn(config, 'get');
    // Construction reads UPSTREAM_TIMEOUT_MS with the fallback baked in.
    new ChatService(config);
    expect(getSpy).toHaveBeenCalledWith('UPSTREAM_TIMEOUT_MS', 120_000);
  });

  it('proxies the request upstream with the bearer key and returns the response', async () => {
    const upstreamResponse = { status: 200, ok: true } as Response;
    fetchMock.mockResolvedValue(upstreamResponse);

    const svc = new ChatService(makeConfig({ NEAR_AI_API_KEY: 'secret-key' }));
    const body = { model: 'm', messages: [] };
    const extraHeaders = { 'X-Encryption-Version': 'v2' };

    const res = await svc.proxyChat(body, extraHeaders);

    expect(res).toBe(upstreamResponse);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${UPSTREAM_BASE_URL}/chat/completions`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-key');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Encryption-Version']).toBe('v2');
    expect(init.body).toBe(JSON.stringify(body));
    expect(init.signal).toBeDefined();
  });

  it('rethrows on an AbortError (timeout) path', async () => {
    const abortErr = Object.assign(new Error('aborted'), {
      name: 'AbortError',
    });
    fetchMock.mockRejectedValue(abortErr);

    const svc = new ChatService(makeConfig({ NEAR_AI_API_KEY: 'k' }));
    await expect(svc.proxyChat({})).rejects.toBe(abortErr);
  });

  it('aborts the request when the upstream timeout elapses', async () => {
    jest.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal;
      // Never resolves on its own — only the abort timer should fire.
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    });

    const svc = new ChatService(makeConfig({ NEAR_AI_API_KEY: 'k', UPSTREAM_TIMEOUT_MS: 50 }));
    const promise = svc.proxyChat({});
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'AbortError',
    });
    jest.advanceTimersByTime(50);
    await assertion;
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('rethrows a generic upstream fetch failure', async () => {
    const err = new Error('ECONNREFUSED');
    fetchMock.mockRejectedValue(err);
    const svc = new ChatService(makeConfig({ NEAR_AI_API_KEY: 'k' }));
    await expect(svc.proxyChat({})).rejects.toBe(err);
  });

  // -------------------------------------------------------------------------
  // C.1 — the deadline is stamped at request entry and covers queue wait
  // -------------------------------------------------------------------------

  it('fails immediately, without an upstream fetch, when the deadline elapsed while queued', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const svc = new ChatService(makeConfig({ NEAR_AI_API_KEY: 'k' }));

    await expect(
      svc.proxyChat({ model: 'm' }, undefined, {
        deadlineAt: Date.now() - 1_000,
        userId: 'user-9',
      }),
    ).rejects.toBeInstanceOf(DeadlineElapsedError);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('deadline elapsed in queue'));
  });

  it('bounds the upstream timer by the REMAINING deadline, not the full budget', async () => {
    jest.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal;
      return new Promise<Response>(() => {}); // never settles on its own
    });

    const svc = new ChatService(makeConfig({ NEAR_AI_API_KEY: 'k', UPSTREAM_TIMEOUT_MS: 1_000 }));
    // 900ms of the 1000ms budget was already spent waiting for a queue slot.
    void svc.proxyChat({}, undefined, { deadlineAt: Date.now() + 100 }).catch(() => undefined);

    jest.advanceTimersByTime(99);
    expect(capturedSignal?.aborted).toBe(false);
    jest.advanceTimersByTime(2);
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('does not start a fetch when the client signal is already aborted', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const svc = new ChatService(makeConfig({ NEAR_AI_API_KEY: 'k' }));
    const aborted = AbortSignal.abort();

    await expect(
      svc.proxyChat({ model: 'm' }, undefined, { signal: aborted }),
    ).rejects.toBeInstanceOf(DeadlineElapsedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // C.2 — an external (client-disconnect) signal aborts the upstream fetch
  // -------------------------------------------------------------------------

  it('aborts the upstream fetch when the external client signal fires', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    let capturedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    });

    const svc = new ChatService(makeConfig({ NEAR_AI_API_KEY: 'k' }));
    const external = new AbortController();
    const promise = svc.proxyChat({}, undefined, { signal: external.signal });
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });

    external.abort();
    await assertion;
    expect(capturedSignal?.aborted).toBe(true);
  });

  // -------------------------------------------------------------------------
  // C.3 — attribution in the timeout log
  // -------------------------------------------------------------------------

  it('names the model and user in the upstream-timeout log line', async () => {
    jest.useFakeTimers();
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    });

    const svc = new ChatService(makeConfig({ NEAR_AI_API_KEY: 'k', UPSTREAM_TIMEOUT_MS: 50 }));
    const promise = svc.proxyChat({ model: 'Qwen/Qwen3.6-35B-A3B-FP8' }, undefined, {
      userId: 'user-42',
    });
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    jest.advanceTimersByTime(50);
    await assertion;

    const line = errorSpy.mock.calls.map((c) => String(c[0])).find((c) => c.includes('timed out'))!;
    expect(line).toContain('upstream request timed out after');
    expect(line).toContain('model=Qwen/Qwen3.6-35B-A3B-FP8');
    expect(line).toContain('user=user-42');
  });

  it('logs model=default user=unknown when neither is supplied', async () => {
    jest.useFakeTimers();
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    });

    const svc = new ChatService(makeConfig({ NEAR_AI_API_KEY: 'k', UPSTREAM_TIMEOUT_MS: 10 }));
    const promise = svc.proxyChat({});
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    jest.advanceTimersByTime(10);
    await assertion;

    const line = errorSpy.mock.calls.map((c) => String(c[0])).find((c) => c.includes('timed out'))!;
    expect(line).toContain('model=default');
    expect(line).toContain('user=unknown');
  });

  it('returns a non-2xx upstream response without throwing (caller handles it)', async () => {
    const upstreamResponse = { status: 500, ok: false } as Response;
    fetchMock.mockResolvedValue(upstreamResponse);
    const svc = new ChatService(makeConfig({ NEAR_AI_API_KEY: 'k' }));
    const res = await svc.proxyChat({});
    expect(res).toBe(upstreamResponse);
  });
});
