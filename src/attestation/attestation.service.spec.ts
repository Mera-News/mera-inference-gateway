import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UPSTREAM_BASE_URL } from '../constants';
import { AttestationService } from './attestation.service';

function makeConfig(values: Record<string, unknown>): ConfigService {
  return {
    get: <T>(key: string, fallback?: T): T => (values[key] as T) ?? (fallback as T),
  } as unknown as ConfigService;
}

function makeUpstream(opts: {
  status: number;
  contentType?: string | null;
  body?: string;
}): globalThis.Response {
  const contentType = opts.contentType ?? 'application/json';
  const body = opts.body ?? 'BODY';
  return {
    status: opts.status,
    ok: opts.status >= 200 && opts.status < 300,
    headers: { get: jest.fn().mockReturnValue(contentType) },
    text: jest.fn().mockResolvedValue(body),
  } as unknown as globalThis.Response;
}

describe('AttestationService', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  let now: number;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('constructor', () => {
    it('throws when NEAR_AI_API_KEY is missing', () => {
      expect(() => new AttestationService(makeConfig({}))).toThrow(/NEAR_AI_API_KEY/);
    });

    it('throws when NEAR_AI_API_KEY is empty string', () => {
      expect(() => new AttestationService(makeConfig({ NEAR_AI_API_KEY: '' }))).toThrow(
        /NEAR_AI_API_KEY/,
      );
    });

    it('succeeds when NEAR_AI_API_KEY is set', () => {
      expect(() => new AttestationService(makeConfig({ NEAR_AI_API_KEY: 'my-key' }))).not.toThrow();
    });
  });

  describe('proxyAttestationReport', () => {
    it('fetches the correct URL with query string, bearer header, GET method, and a signal', async () => {
      fetchMock.mockResolvedValue(makeUpstream({ status: 200 }));

      const svc = new AttestationService(makeConfig({ NEAR_AI_API_KEY: 'secret-key' }));
      await svc.proxyAttestationReport('a=1&b=2');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${UPSTREAM_BASE_URL}/attestation/report?a=1&b=2`);
      expect(init.method).toBe('GET');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer secret-key');
      expect(init.signal).toBeDefined();
    });

    it('builds a URL with NO `?` suffix when queryString is empty', async () => {
      fetchMock.mockResolvedValue(makeUpstream({ status: 200 }));

      const svc = new AttestationService(makeConfig({ NEAR_AI_API_KEY: 'k' }));
      await svc.proxyAttestationReport('');

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${UPSTREAM_BASE_URL}/attestation/report`);
      expect(url).not.toContain('?');
    });

    it('on a cache miss (200), returns a Response with the upstream status, body, and content-type', async () => {
      fetchMock.mockResolvedValue(
        makeUpstream({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
      );

      const svc = new AttestationService(makeConfig({ NEAR_AI_API_KEY: 'k' }));
      const result = await svc.proxyAttestationReport('nonce=xyz');

      expect(result.status).toBe(200);
      expect(result.headers.get('content-type')).toBe('application/json');
      await expect(result.text()).resolves.toBe('{"ok":true}');
    });

    it('passes through a non-200 upstream Response unchanged (no buffering, no cache)', async () => {
      const upstreamResponse = { status: 500, ok: false } as unknown as globalThis.Response;
      fetchMock.mockResolvedValue(upstreamResponse);

      const svc = new AttestationService(makeConfig({ NEAR_AI_API_KEY: 'k' }));
      const result = await svc.proxyAttestationReport('nonce=xyz');

      expect(result).toBe(upstreamResponse);
    });

    it('throws matching /Upstream attestation timeout after 30000ms/ when fetch rejects with AbortError', async () => {
      const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
      fetchMock.mockRejectedValue(abortErr);

      const svc = new AttestationService(makeConfig({ NEAR_AI_API_KEY: 'k' }));
      await expect(svc.proxyAttestationReport('nonce=1')).rejects.toThrow(
        /Upstream attestation timeout after 30000ms/,
      );
    });

    it('rethrows a generic Error without wrapping it', async () => {
      const err = new Error('ECONNREFUSED');
      fetchMock.mockRejectedValue(err);

      const svc = new AttestationService(makeConfig({ NEAR_AI_API_KEY: 'k' }));
      await expect(svc.proxyAttestationReport('nonce=1')).rejects.toBe(err);
    });

    describe('caching', () => {
      it('serves a second identical request from cache without a second upstream call, within TTL', async () => {
        fetchMock.mockResolvedValue(
          makeUpstream({ status: 200, contentType: 'application/json', body: 'CACHED_BODY' }),
        );

        const svc = new AttestationService(makeConfig({ NEAR_AI_API_KEY: 'k' }));
        const first = await svc.proxyAttestationReport('model=a&algo=b');

        now += 5 * 60 * 1000; // 5 minutes later, still within the 10-minute TTL
        const second = await svc.proxyAttestationReport('model=a&algo=b');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(second.status).toBe(200);
        await expect(second.text()).resolves.toBe('CACHED_BODY');
        await expect(first.text()).resolves.toBe('CACHED_BODY');
      });

      it('refetches upstream once the cache entry has expired past the TTL', async () => {
        fetchMock.mockResolvedValue(makeUpstream({ status: 200, body: 'BODY_1' }));

        const svc = new AttestationService(makeConfig({ NEAR_AI_API_KEY: 'k' }));
        await svc.proxyAttestationReport('model=a&algo=b');

        now += 10 * 60 * 1000 + 1; // just past the 10-minute TTL
        fetchMock.mockResolvedValue(makeUpstream({ status: 200, body: 'BODY_2' }));
        const second = await svc.proxyAttestationReport('model=a&algo=b');

        expect(fetchMock).toHaveBeenCalledTimes(2);
        await expect(second.text()).resolves.toBe('BODY_2');
      });

      it('does not cache non-200 responses -- repeats the upstream call every time', async () => {
        fetchMock.mockResolvedValue(makeUpstream({ status: 503, body: 'unavailable' }));

        const svc = new AttestationService(makeConfig({ NEAR_AI_API_KEY: 'k' }));
        await svc.proxyAttestationReport('model=a&algo=b');
        await svc.proxyAttestationReport('model=a&algo=b');

        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      it('caches distinct query strings independently', async () => {
        fetchMock.mockResolvedValue(makeUpstream({ status: 200, body: 'BODY' }));

        const svc = new AttestationService(makeConfig({ NEAR_AI_API_KEY: 'k' }));
        await svc.proxyAttestationReport('model=a');
        await svc.proxyAttestationReport('model=b');
        await svc.proxyAttestationReport('model=a');
        await svc.proxyAttestationReport('model=b');

        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      it('bounds the cache to 20 entries, evicting the oldest on overflow', async () => {
        const svc = new AttestationService(makeConfig({ NEAR_AI_API_KEY: 'k' }));

        // Fill the cache with 20 distinct entries (model=0 .. model=19).
        for (let i = 0; i < 20; i++) {
          fetchMock.mockResolvedValueOnce(makeUpstream({ status: 200, body: `BODY_${i}` }));
          await svc.proxyAttestationReport(`model=${i}`);
        }
        expect(fetchMock).toHaveBeenCalledTimes(20);

        // A 21st distinct entry evicts the oldest (model=0).
        fetchMock.mockResolvedValueOnce(makeUpstream({ status: 200, body: 'BODY_20' }));
        await svc.proxyAttestationReport('model=20');
        expect(fetchMock).toHaveBeenCalledTimes(21);

        // model=0 was evicted -- re-requesting it triggers a fresh upstream call.
        fetchMock.mockResolvedValueOnce(makeUpstream({ status: 200, body: 'BODY_0_REFETCHED' }));
        const evicted = await svc.proxyAttestationReport('model=0');
        expect(fetchMock).toHaveBeenCalledTimes(22);
        await expect(evicted.text()).resolves.toBe('BODY_0_REFETCHED');

        // model=19, never evicted, is still served from cache.
        const stillCached = await svc.proxyAttestationReport('model=19');
        expect(fetchMock).toHaveBeenCalledTimes(22);
        await expect(stillCached.text()).resolves.toBe('BODY_19');
      });
    });
  });
});
