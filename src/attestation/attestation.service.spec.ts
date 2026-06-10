import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UPSTREAM_BASE_URL } from '../constants';
import { AttestationService } from './attestation.service';

function makeConfig(values: Record<string, unknown>): ConfigService {
  return {
    get: <T>(key: string, fallback?: T): T => (values[key] as T) ?? (fallback as T),
  } as unknown as ConfigService;
}

describe('AttestationService', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
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
      expect(
        () => new AttestationService(makeConfig({ NEAR_AI_API_KEY: '' })),
      ).toThrow(/NEAR_AI_API_KEY/);
    });

    it('succeeds when NEAR_AI_API_KEY is set', () => {
      expect(
        () => new AttestationService(makeConfig({ NEAR_AI_API_KEY: 'my-key' })),
      ).not.toThrow();
    });
  });

  describe('proxyAttestationReport', () => {
    it('fetches the correct URL with query string, bearer header, GET method, and a signal', async () => {
      const upstreamResponse = { status: 200, ok: true } as Response;
      fetchMock.mockResolvedValue(upstreamResponse);

      const svc = new AttestationService(makeConfig({ NEAR_AI_API_KEY: 'secret-key' }));
      const result = await svc.proxyAttestationReport('a=1&b=2');

      expect(result).toBe(upstreamResponse);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${UPSTREAM_BASE_URL}/attestation/report?a=1&b=2`);
      expect(init.method).toBe('GET');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer secret-key');
      expect(init.signal).toBeDefined();
    });

    it('returns the raw Response object unchanged', async () => {
      const upstreamResponse = { status: 200, ok: true, custom: 'data' } as unknown as Response;
      fetchMock.mockResolvedValue(upstreamResponse);

      const svc = new AttestationService(makeConfig({ NEAR_AI_API_KEY: 'k' }));
      const result = await svc.proxyAttestationReport('nonce=xyz');

      expect(result).toBe(upstreamResponse);
    });

    it('builds a URL with NO `?` suffix when queryString is empty', async () => {
      const upstreamResponse = { status: 200, ok: true } as Response;
      fetchMock.mockResolvedValue(upstreamResponse);

      const svc = new AttestationService(makeConfig({ NEAR_AI_API_KEY: 'k' }));
      await svc.proxyAttestationReport('');

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${UPSTREAM_BASE_URL}/attestation/report`);
      expect(url).not.toContain('?');
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
  });
});
