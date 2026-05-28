import { ConfigService } from '@nestjs/config';
import { UPSTREAM_BASE_URL } from '../constants';
import { ChatService } from './chat.service';

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
  });

  it('throws at construction when NEAR_AI_API_KEY is missing', () => {
    expect(() => new ChatService(makeConfig({}))).toThrow(/NEAR_AI_API_KEY/);
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

  it('returns a non-2xx upstream response without throwing (caller handles it)', async () => {
    const upstreamResponse = { status: 500, ok: false } as Response;
    fetchMock.mockResolvedValue(upstreamResponse);
    const svc = new ChatService(makeConfig({ NEAR_AI_API_KEY: 'k' }));
    const res = await svc.proxyChat({});
    expect(res).toBe(upstreamResponse);
  });
});
