import { BadRequestException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SEARCH_UNAVAILABLE_CODE } from '../search-unavailable';
import {
  FactCheckClaimsService,
  FetchFn,
  MAX_CLAIM_QUERY_LENGTH,
  MAX_CLAIM_REVIEWS,
  MIN_CLAIM_QUERY_LENGTH,
  CLAIMS_PAGE_SIZE,
} from './fact-check-claims.service';

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

/** One real-shaped upstream payload: PolitiFact's actual verdict wording is the
 *  point of the whole route, so the fixture uses it rather than 'foo'. */
function claimsBody(reviewsPerClaim = 1, claims = 1) {
  return {
    claims: Array.from({ length: claims }, (_, c) => ({
      text: `claim ${c}`,
      claimant: 'Someone',
      claimDate: '2026-08-01T00:00:00Z',
      claimReview: Array.from({ length: reviewsPerClaim }, (_, r) => ({
        publisher: { name: 'PolitiFact', site: 'politifact.com' },
        url: `https://politifact.invalid/${c}-${r}`,
        title: `Review ${c}-${r}`,
        reviewDate: '2026-08-02T00:00:00Z',
        textualRating: 'Pants on Fire',
        languageCode: 'en',
      })),
    })),
  };
}

const ENABLED = {
  FACT_CHECK_TOOLS_ENABLED: 'true',
  FACT_CHECK_TOOLS_API_KEY: 'gfc-key',
};

function makeService(
  values: Record<string, unknown>,
  fetchMock: jest.Mock = jest.fn(),
): { service: FactCheckClaimsService; fetchMock: jest.Mock } {
  const service = new FactCheckClaimsService(makeConfig(values), fetchMock as unknown as FetchFn);
  return { service, fetchMock };
}

async function expectUnavailable(promise: Promise<unknown>, reason: string): Promise<void> {
  await expect(promise).rejects.toThrow(ServiceUnavailableException);
  await promise.catch((error: ServiceUnavailableException) => {
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toMatchObject({ code: SEARCH_UNAVAILABLE_CODE, reason });
  });
}

describe('FactCheckClaimsService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  // DISABLED IS NOT EMPTY — the same counter-metric as WebSearchService's. Here
  // it matters more: an empty result on THIS route means "no fact-checker has
  // ruled on this claim", which is a publishable statement about the world.
  describe('gate (FACT_CHECK_TOOLS_ENABLED)', () => {
    it('defaults to OFF and 503s search-unavailable without touching fetch', async () => {
      const { service, fetchMock } = makeService({ FACT_CHECK_TOOLS_API_KEY: 'gfc-key' });
      await expectUnavailable(service.searchClaims('a claim'), 'disabled');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(['false', 'FALSE', '0', 'yes', ''])(
      'stays off for FACT_CHECK_TOOLS_ENABLED=%p',
      async (flag) => {
        const { service, fetchMock } = makeService({ FACT_CHECK_TOOLS_ENABLED: flag });
        await expectUnavailable(service.searchClaims('a claim'), 'disabled');
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it.each(['true', 'TRUE', 'True'])('turns on for %p', async (flag) => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(claimsBody()));
      const { service } = makeService(
        { FACT_CHECK_TOOLS_ENABLED: flag, FACT_CHECK_TOOLS_API_KEY: 'k' },
        fetchMock,
      );
      await service.searchClaims('a claim');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('validates length BEFORE the gate, so a bad query 400s even when disabled', async () => {
      const { service } = makeService({});
      await expect(service.searchClaims('a')).rejects.toThrow(BadRequestException);
    });

    it('does not construct-time throw when the API key is absent (boot must not fail)', () => {
      expect(() => makeService({})).not.toThrow();
    });

    it('503s search-unavailable when enabled without a key, never calling Google', async () => {
      const { service, fetchMock } = makeService({ FACT_CHECK_TOOLS_ENABLED: 'true' });
      await expectUnavailable(service.searchClaims('a claim'), 'not-configured');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('query guards', () => {
    it(`rejects a query shorter than ${MIN_CLAIM_QUERY_LENGTH} characters`, async () => {
      const { service } = makeService(ENABLED);
      await expect(service.searchClaims('a')).rejects.toThrow(BadRequestException);
    });

    it('rejects a whitespace-only query (trim happens first)', async () => {
      const { service } = makeService(ENABLED);
      await expect(service.searchClaims('   ')).rejects.toThrow(BadRequestException);
    });

    it('rejects a null/undefined query', async () => {
      const { service } = makeService(ENABLED);
      await expect(service.searchClaims(undefined as unknown as string)).rejects.toThrow(
        BadRequestException,
      );
    });

    it(`rejects a query longer than ${MAX_CLAIM_QUERY_LENGTH} characters`, async () => {
      const { service, fetchMock } = makeService(ENABLED);
      await expect(service.searchClaims('a'.repeat(MAX_CLAIM_QUERY_LENGTH + 1))).rejects.toThrow(
        BadRequestException,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it(`accepts exactly ${MAX_CLAIM_QUERY_LENGTH} characters`, async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(claimsBody()));
      const { service } = makeService(ENABLED, fetchMock);
      await expect(service.searchClaims('a'.repeat(MAX_CLAIM_QUERY_LENGTH))).resolves.toHaveLength(
        1,
      );
    });

    it('sends the trimmed query upstream', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(claimsBody()));
      const { service } = makeService(ENABLED, fetchMock);
      await service.searchClaims('   a  claim   ');
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(new URL(url).searchParams.get('query')).toBe('a  claim');
    });
  });

  describe('upstream request', () => {
    it('GETs claims:search with an empty body and API-key auth', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(claimsBody()));
      const { service } = makeService(ENABLED, fetchMock);

      await service.searchClaims('a claim');

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('https://factchecktools.googleapis.com/v1alpha1/claims:search');
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
      expect(new URL(url).searchParams.get('key')).toBe('gfc-key');
      expect(new URL(url).searchParams.get('pageSize')).toBe(String(CLAIMS_PAGE_SIZE));
      expect(init.signal).toBeDefined();
    });

    it('sends the claim and nothing about the caller', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(claimsBody()));
      const { service } = makeService(ENABLED, fetchMock);
      await service.searchClaims('a claim', 'en', 30);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect([...new URL(url).searchParams.keys()].sort()).toEqual([
        'key',
        'languageCode',
        'maxAgeDays',
        'pageSize',
        'query',
      ]);
      expect(Object.keys(init.headers as Record<string, string>)).toEqual(['Accept']);
    });

    it('omits languageCode entirely when it is not supplied', async () => {
      // Not "sends an empty one" — a locale filter can turn a real hit into a
      // false "nobody checked this", so the unset retry has to be a real
      // unfiltered request.
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(claimsBody()));
      const { service } = makeService(ENABLED, fetchMock);
      await service.searchClaims('a claim');
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(new URL(url).searchParams.has('languageCode')).toBe(false);
      expect(new URL(url).searchParams.has('maxAgeDays')).toBe(false);
    });

    it('never logs the claim text or the key — both live in the request URL', async () => {
      const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(claimsBody()));
      const { service } = makeService(ENABLED, fetchMock);

      await service.searchClaims('a-very-distinctive-secret-claim');

      const emitted = [
        ...debug.mock.calls,
        ...log.mock.calls,
        ...warn.mock.calls,
        ...error.mock.calls,
      ]
        .flat()
        .join(' ');
      expect(emitted).not.toContain('a-very-distinctive-secret-claim');
      expect(emitted).not.toContain('gfc-key');
    });

    it('keeps the key and the claim out of every unavailable body', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse({}, 429));
      const { service } = makeService(ENABLED, fetchMock);
      await service
        .searchClaims('a-very-distinctive-secret-claim')
        .catch((err: ServiceUnavailableException) => {
          const body = JSON.stringify(err.getResponse());
          expect(body).not.toContain('gfc-key');
          expect(body).not.toContain('a-very-distinctive-secret-claim');
        });
    });
  });

  describe('response mapping', () => {
    it('flattens claimReview[] and carries the parent claim context', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(claimsBody()));
      const { service } = makeService(ENABLED, fetchMock);

      await expect(service.searchClaims('a claim')).resolves.toEqual([
        {
          claim: 'claim 0',
          claimant: 'Someone',
          claimDate: '2026-08-01T00:00:00Z',
          publisher: { name: 'PolitiFact', site: 'politifact.com' },
          url: 'https://politifact.invalid/0-0',
          title: 'Review 0-0',
          reviewDate: '2026-08-02T00:00:00Z',
          textualRating: 'Pants on Fire',
          languageCode: 'en',
        },
      ]);
    });

    it('returns the verdict wording verbatim — it is never normalised', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        jsonResponse({
          claims: [
            {
              text: 'c',
              claimReview: [{ url: 'https://u.invalid', textualRating: 'Mostly False' }],
            },
          ],
        }),
      );
      const { service } = makeService(ENABLED, fetchMock);
      const [item] = await service.searchClaims('a claim');
      expect(item.textualRating).toBe('Mostly False');
    });

    it('emits several rows for one claim reviewed by several organisations', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(claimsBody(3, 1)));
      const { service } = makeService(ENABLED, fetchMock);
      await expect(service.searchClaims('a claim')).resolves.toHaveLength(3);
    });

    it(`caps the flattened list at ${MAX_CLAIM_REVIEWS}`, async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(claimsBody(5, 10)));
      const { service } = makeService(ENABLED, fetchMock);
      await expect(service.searchClaims('a claim')).resolves.toHaveLength(MAX_CLAIM_REVIEWS);
    });

    it('drops a review with no url and defaults missing text fields', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        jsonResponse({
          claims: [
            {
              text: 'c',
              claimReview: [
                { title: 'no url' },
                { url: '' },
                { url: 'https://ok.invalid', publisher: { name: 5 } },
              ],
            },
          ],
        }),
      );
      const { service } = makeService(ENABLED, fetchMock);
      await expect(service.searchClaims('a claim')).resolves.toEqual([
        {
          claim: 'c',
          claimant: '',
          claimDate: '',
          publisher: { name: '', site: '' },
          url: 'https://ok.invalid',
          title: '',
          reviewDate: '',
          textualRating: '',
          languageCode: '',
        },
      ]);
    });

    // THE HONEST EMPTY, and the ~96% case on this corpus. Google answers `{}`
    // for a claim no IFCN signatory has reviewed. That is a fact about the
    // world, delivered behind a 200 — it must never be an error, and it must
    // never be confused with the 503s above.
    it('returns [] behind a 200 when nobody has published on the claim', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse({}));
      const { service } = makeService(ENABLED, fetchMock);
      await expect(service.searchClaims('a claim')).resolves.toEqual([]);
    });

    it('returns [] when claims exist but carry no reviews', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValue(
          jsonResponse({ claims: [{ text: 'c' }, { text: 'd', claimReview: [] }] }),
        );
      const { service } = makeService(ENABLED, fetchMock);
      await expect(service.searchClaims('a claim')).resolves.toEqual([]);
    });

    it.each([401, 403])('maps a rejected key (%i) to 503 search-unavailable', async (status) => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ error: 'x' }, status));
      const { service } = makeService(ENABLED, fetchMock);
      await expectUnavailable(service.searchClaims('a claim'), 'upstream-rejected-key');
    });

    // The published quota for this API is undocumented, so this is the branch
    // most likely to fire under real load. It must read as "blocked".
    it('maps a 429 to 503 search-unavailable, never to "nobody checked this"', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse({}, 429));
      const { service } = makeService(ENABLED, fetchMock);
      await expectUnavailable(service.searchClaims('a claim'), 'upstream-rate-limited');
    });

    it('throws on any other non-2xx status without leaking the body', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ secret: 'x' }, 500));
      const { service } = makeService(ENABLED, fetchMock);
      await expect(service.searchClaims('a claim')).rejects.toThrow(
        'Fact check claims lookup failed with status 500',
      );
    });

    it('propagates a network failure', async () => {
      const fetchMock = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
      const { service } = makeService(ENABLED, fetchMock);
      await expect(service.searchClaims('a claim')).rejects.toThrow('ECONNRESET');
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

      const pending = service.searchClaims('a claim');
      jest.advanceTimersByTime(8_000);

      await expect(pending).rejects.toThrow(/timed out/);
      expect(capturedSignal?.aborted).toBe(true);
    });

    it('clears the deadline timer on success', async () => {
      jest.useFakeTimers();
      const clearSpy = jest.spyOn(global, 'clearTimeout');
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(claimsBody()));
      const { service } = makeService(ENABLED, fetchMock);

      await service.searchClaims('a claim');

      expect(clearSpy).toHaveBeenCalled();
    });
  });
});
