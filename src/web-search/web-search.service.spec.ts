import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  FetchFn,
  MAX_QUERY_LENGTH,
  MAX_WEB_SEARCH_RESULTS,
  MIN_QUERY_LENGTH,
  WebSearchService,
} from './web-search.service';

function makeConfig(values: Record<string, unknown>): ConfigService {
  return {
    get: <T>(key: string, fallback?: T): T =>
      key in values ? (values[key] as T) : (fallback as T),
  } as unknown as ConfigService;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function braveBody(count: number) {
  return {
    web: {
      results: Array.from({ length: count }, (_, i) => ({
        title: `title ${i}`,
        url: `https://example.invalid/${i}`,
        description: `snippet ${i}`,
      })),
    },
  };
}

const ENABLED = { BRAVE_SEARCH_ENABLED: 'true', BRAVE_SEARCH_API_KEY: 'brave-key' };

function makeService(
  values: Record<string, unknown>,
  fetchMock: jest.Mock = jest.fn(),
): { service: WebSearchService; fetchMock: jest.Mock } {
  const service = new WebSearchService(makeConfig(values), fetchMock as unknown as FetchFn);
  return { service, fetchMock };
}

describe('WebSearchService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('spend gate (BRAVE_SEARCH_ENABLED)', () => {
    it('defaults to OFF and returns an empty list without touching fetch', async () => {
      const { service, fetchMock } = makeService({ BRAVE_SEARCH_API_KEY: 'brave-key' });
      await expect(service.search('anything')).resolves.toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(['false', 'FALSE', '0', 'yes', ''])(
      'stays off for BRAVE_SEARCH_ENABLED=%p',
      async (flag) => {
        const { service, fetchMock } = makeService({ BRAVE_SEARCH_ENABLED: flag });
        await expect(service.search('anything')).resolves.toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it.each(['true', 'TRUE', 'True'])('turns on for %p', async (flag) => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(braveBody(1)));
      const { service } = makeService(
        { BRAVE_SEARCH_ENABLED: flag, BRAVE_SEARCH_API_KEY: 'k' },
        fetchMock,
      );
      await service.search('anything');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('validates length BEFORE the gate, so a bad query 400s even when disabled', async () => {
      const { service } = makeService({});
      await expect(service.search('a')).rejects.toThrow(BadRequestException);
    });

    it('does not construct-time throw when the API key is absent (boot must not fail)', () => {
      expect(() => makeService({})).not.toThrow();
    });

    it('throws when enabled without an API key rather than calling Brave keyless', async () => {
      const { service, fetchMock } = makeService({ BRAVE_SEARCH_ENABLED: 'true' });
      await expect(service.search('anything')).rejects.toThrow(/BRAVE_SEARCH_API_KEY/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('query guards', () => {
    it(`rejects a query shorter than ${MIN_QUERY_LENGTH} characters`, async () => {
      const { service } = makeService(ENABLED);
      await expect(service.search('a')).rejects.toThrow(BadRequestException);
    });

    it('rejects a whitespace-only query (trim happens first)', async () => {
      const { service } = makeService(ENABLED);
      await expect(service.search('    ')).rejects.toThrow(BadRequestException);
    });

    it('rejects a null/undefined query', async () => {
      const { service } = makeService(ENABLED);
      await expect(service.search(undefined as unknown as string)).rejects.toThrow(
        BadRequestException,
      );
    });

    it(`accepts exactly ${MIN_QUERY_LENGTH} characters`, async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(braveBody(1)));
      const { service } = makeService(ENABLED, fetchMock);
      await expect(service.search('a'.repeat(MIN_QUERY_LENGTH))).resolves.toHaveLength(1);
    });

    it(`rejects a query longer than ${MAX_QUERY_LENGTH} characters`, async () => {
      const { service, fetchMock } = makeService(ENABLED);
      await expect(service.search('a'.repeat(MAX_QUERY_LENGTH + 1))).rejects.toThrow(
        BadRequestException,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it(`accepts exactly ${MAX_QUERY_LENGTH} characters`, async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(braveBody(1)));
      const { service } = makeService(ENABLED, fetchMock);
      await expect(service.search('a'.repeat(MAX_QUERY_LENGTH))).resolves.toHaveLength(1);
    });

    it('sends the trimmed query to Brave', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(braveBody(1)));
      const { service } = makeService(ENABLED, fetchMock);
      await service.search('   brave  search   ');
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain(`q=${encodeURIComponent('brave  search')}`);
    });
  });

  describe('Brave request', () => {
    it('hits the Brave endpoint with the key in X-Subscription-Token and never in the URL', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(braveBody(1)));
      const { service } = makeService(ENABLED, fetchMock);

      await service.search('climate');

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('https://api.search.brave.com/res/v1/web/search?q=climate');
      expect(url).not.toContain('brave-key');
      expect(init.method).toBe('GET');
      const headers = init.headers as Record<string, string>;
      expect(headers['X-Subscription-Token']).toBe('brave-key');
      expect(headers.Accept).toBe('application/json');
      expect(init.signal).toBeDefined();
    });

    it(`asks Brave for at most ${MAX_WEB_SEARCH_RESULTS} results`, async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(braveBody(1)));
      const { service } = makeService(ENABLED, fetchMock);
      await service.search('climate');
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain(`count=${MAX_WEB_SEARCH_RESULTS}`);
    });

    it('never sends the caller identity or anything but the query', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(braveBody(1)));
      const { service } = makeService(ENABLED, fetchMock);
      await service.search('climate');
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(new URL(url).searchParams.get('q')).toBe('climate');
      expect([...new URL(url).searchParams.keys()].sort()).toEqual(['count', 'q']);
      expect(init.body).toBeUndefined();
      expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual([
        'Accept',
        'Accept-Encoding',
        'X-Subscription-Token',
      ]);
    });

    it('never logs the query text', async () => {
      const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(braveBody(1)));
      const { service } = makeService(ENABLED, fetchMock);

      await service.search('a-very-distinctive-secret-query');

      const emitted = [...debug.mock.calls, ...log.mock.calls, ...warn.mock.calls].flat().join(' ');
      expect(emitted).not.toContain('a-very-distinctive-secret-query');
      expect(emitted).not.toContain('brave-key');
    });
  });

  describe('Brave response', () => {
    it('maps title/url/description to title/url/snippet', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        jsonResponse({
          web: {
            results: [{ title: 't', url: 'https://u.invalid', description: 'd' }],
          },
        }),
      );
      const { service } = makeService(ENABLED, fetchMock);
      await expect(service.search('climate')).resolves.toEqual([
        { title: 't', url: 'https://u.invalid', snippet: 'd' },
      ]);
    });

    it(`caps results at ${MAX_WEB_SEARCH_RESULTS} even if Brave over-returns`, async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(braveBody(25)));
      const { service } = makeService(ENABLED, fetchMock);
      await expect(service.search('climate')).resolves.toHaveLength(MAX_WEB_SEARCH_RESULTS);
    });

    it('drops entries without a usable url and defaults missing text fields', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        jsonResponse({
          web: {
            results: [
              { title: 'no url' },
              { url: '' },
              { url: 'https://ok.invalid' },
              { url: 'https://ok2.invalid', title: 5, description: null },
            ],
          },
        }),
      );
      const { service } = makeService(ENABLED, fetchMock);
      await expect(service.search('climate')).resolves.toEqual([
        { title: '', url: 'https://ok.invalid', snippet: '' },
        { title: '', url: 'https://ok2.invalid', snippet: '' },
      ]);
    });

    it('returns [] when the body has no web.results array', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ web: {} }));
      const { service } = makeService(ENABLED, fetchMock);
      await expect(service.search('climate')).resolves.toEqual([]);
    });

    it('returns [] when the body is empty', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(null));
      const { service } = makeService(ENABLED, fetchMock);
      await expect(service.search('climate')).resolves.toEqual([]);
    });

    it('throws on a non-2xx status without leaking the body', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ secret: 'x' }, 422));
      const { service } = makeService(ENABLED, fetchMock);
      await expect(service.search('climate')).rejects.toThrow(
        'Brave search failed with status 422',
      );
    });

    it('propagates a network failure', async () => {
      const fetchMock = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
      const { service } = makeService(ENABLED, fetchMock);
      await expect(service.search('climate')).rejects.toThrow('ECONNRESET');
    });
  });

  describe('deadline', () => {
    it('aborts the upstream request once the deadline elapses', async () => {
      jest.useFakeTimers();
      let capturedSignal: AbortSignal | undefined;
      const fetchMock = jest.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            capturedSignal = init.signal as AbortSignal;
            capturedSignal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      );
      const { service } = makeService(ENABLED, fetchMock as unknown as jest.Mock);

      const pending = service.search('climate');
      jest.advanceTimersByTime(8_000);

      await expect(pending).rejects.toThrow(/timed out/);
      expect(capturedSignal?.aborted).toBe(true);
    });

    it('clears the deadline timer on success', async () => {
      jest.useFakeTimers();
      const clearSpy = jest.spyOn(global, 'clearTimeout');
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(braveBody(1)));
      const { service } = makeService(ENABLED, fetchMock);

      await service.search('climate');

      expect(clearSpy).toHaveBeenCalled();
    });
  });
});
