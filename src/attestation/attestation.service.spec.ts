import { generateKeyPairSync } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UPSTREAM_BASE_URL } from '../constants';
import { AttestationService, slimAttestationForHotPath } from './attestation.service';

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

const NRAS_ATTEST_URL = 'https://nras.attestation.nvidia.com/v4/attest/gpu';
const NRAS_JWKS_URL = 'https://nras.attestation.nvidia.com/.well-known/jwks.json';

describe('AttestationService', () => {
  const originalFetch = global.fetch;
  /** NEAR. NVIDIA has its own two mocks, so no test can pass on a shared one. */
  let fetchMock: jest.Mock;
  let nrasMock: jest.Mock;
  let jwksMock: jest.Mock;
  let now: number;

  beforeEach(() => {
    fetchMock = jest.fn();
    nrasMock = jest.fn().mockRejectedValue(new Error('NRAS not set up for this test'));
    jwksMock = jest.fn().mockRejectedValue(new Error('JWKS not set up for this test'));
    global.fetch = jest.fn((url: string, init?: RequestInit) => {
      if (url === NRAS_ATTEST_URL) return nrasMock(url, init) as Promise<globalThis.Response>;
      if (url === NRAS_JWKS_URL) return jwksMock(url, init) as Promise<globalThis.Response>;
      return fetchMock(url, init) as Promise<globalThis.Response>;
    });
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

    describe('hot-path projection', () => {
      const fullReport = JSON.stringify({
        gateway_attestation: {
          signing_address: 'gw-addr',
          signing_algo: 'ed25519',
          intel_quote: 'Q'.repeat(10_000),
          info: { app_compose: 'C'.repeat(40_000) },
        },
        model_attestations: [
          {
            model_name: 'Qwen/Qwen3.8-27B',
            signing_address: 'addr',
            signing_algo: 'ed25519',
            signing_public_key: 'a'.repeat(64),
            request_nonce: 'n'.repeat(64),
            intel_quote: 'Q'.repeat(10_000),
            nvidia_payload: 'N'.repeat(98_000),
            event_log: [{ imr: 0 }],
            info: { app_compose: 'C'.repeat(40_000) },
          },
        ],
      });

      it('projects a nonce-free 200 body down to the signing fields (key material untouched)', async () => {
        fetchMock.mockResolvedValue(makeUpstream({ status: 200, body: fullReport }));
        const svc = new AttestationService(makeConfig({ NEAR_AI_API_KEY: 'k' }));

        const result = await svc.proxyAttestationReport(
          'model=Qwen%2FQwen3.8-27B&signing_algo=ed25519',
        );
        const text = await result.text();
        const body = JSON.parse(text) as {
          model_attestations: Record<string, unknown>[];
          gateway_attestation: Record<string, unknown>;
        };

        expect(body.model_attestations).toEqual([
          {
            model_name: 'Qwen/Qwen3.8-27B',
            signing_address: 'addr',
            signing_algo: 'ed25519',
            signing_public_key: 'a'.repeat(64),
            request_nonce: 'n'.repeat(64),
          },
        ]);
        expect(body.gateway_attestation).toEqual({
          signing_address: 'gw-addr',
          signing_algo: 'ed25519',
        });
        expect(text.length).toBeLessThan(600);
        expect(fullReport.length).toBeGreaterThan(150_000);
      });

      it("hands back the nonce'd report verbatim when NVIDIA does not answer", async () => {
        fetchMock.mockResolvedValue(makeUpstream({ status: 200, body: fullReport }));
        nrasMock.mockRejectedValue(new Error('unreachable'));
        const svc = new AttestationService(makeConfig({ NEAR_AI_API_KEY: 'k' }));

        const result = await svc.proxyAttestationReport('model=x&signing_algo=ed25519&nonce=abc');

        expect(nrasMock).toHaveBeenCalledTimes(1);
        expect(result.status).toBe(200);
        await expect(result.text()).resolves.toBe(fullReport);
      });

      it('makes no NVIDIA call on a nonce-free request', async () => {
        fetchMock.mockResolvedValue(makeUpstream({ status: 200, body: fullReport }));
        const svc = new AttestationService(makeConfig({ NEAR_AI_API_KEY: 'k' }));

        const result = await svc.proxyAttestationReport('model=x&signing_algo=ed25519');

        expect(nrasMock).not.toHaveBeenCalled();
        expect(jwksMock).not.toHaveBeenCalled();
        await expect(result.text()).resolves.toBe(slimAttestationForHotPath(fullReport));
      });

      it('caches the projected body, so a repeat hit is the slim one too', async () => {
        fetchMock.mockResolvedValue(makeUpstream({ status: 200, body: fullReport }));
        const svc = new AttestationService(makeConfig({ NEAR_AI_API_KEY: 'k' }));

        await svc.proxyAttestationReport('model=x');
        const second = await svc.proxyAttestationReport('model=x');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect((await second.text()).length).toBeLessThan(600);
      });

      it('leaves a body it does not recognise alone', () => {
        expect(slimAttestationForHotPath('not json')).toBe('not json');
        expect(slimAttestationForHotPath('{"ok":true}')).toBe('{"ok":true}');
        expect(slimAttestationForHotPath('[1,2]')).toBe('[1,2]');
        expect(slimAttestationForHotPath('{"model_attestations":"nope"}')).toBe(
          '{"model_attestations":"nope"}',
        );
      });

      it('drops a malformed attestation entry instead of throwing', () => {
        const out = JSON.parse(
          slimAttestationForHotPath('{"model_attestations":[null, 5, {"signing_public_key":"k"}]}'),
        ) as { model_attestations: unknown[] };
        expect(out.model_attestations).toEqual([{ signing_public_key: 'k' }]);
      });
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

      it("never stores a nonce'd report: the same query goes upstream twice", async () => {
        fetchMock.mockResolvedValue(makeUpstream({ status: 200, body: 'BODY' }));

        const svc = new AttestationService(makeConfig({ NEAR_AI_API_KEY: 'k' }));
        await svc.proxyAttestationReport('model=a&nonce=abc');
        await svc.proxyAttestationReport('model=a&nonce=abc');

        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
    });

    describe('GPU attestation relay', () => {
      const QUERY = 'model=x&signing_algo=ed25519&nonce=abc';
      const PAYLOAD = JSON.stringify({ nonce: 'abc', arch: 'HOPPER', evidence_list: [{ e: 1 }] });
      const REPORT = JSON.stringify({
        gateway_attestation: { signing_address: 'gw' },
        model_attestations: [{ model_name: 'x', intel_quote: 'Q', nvidia_payload: PAYLOAD }],
      });

      /** A real P-384 key: jose imports it before it will select it. */
      function signingKey(kid: string): Record<string, unknown> {
        const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-384' });
        return { ...publicKey.export({ format: 'jwk' }), kid, x5c: [`leaf-${kid}`, `int-${kid}`] };
      }

      function token(kid: string, claim = 'secret-claim'): string {
        const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
        return `${part({ kid, alg: 'ES384' })}.${part({ claim })}.sig`;
      }

      const json = (body: unknown, status = 200) =>
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

      function nearAnswers(body = REPORT, tookMs = 0): void {
        fetchMock.mockImplementation(() => {
          now += tookMs;
          return Promise.resolve(makeUpstream({ status: 200, body }));
        });
      }

      function nvidiaAnswers(tokens: unknown, keys: unknown[]): void {
        nrasMock.mockImplementation(() => Promise.resolve(json(tokens)));
        jwksMock.mockImplementation(() => Promise.resolve(json({ keys })));
      }

      /** Like real fetch, answers nothing until its signal aborts. */
      function hangsUntilAborted(_url: string, init: RequestInit): Promise<never> {
        return new Promise((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
        });
      }

      async function tap(svc: AttestationService, query = QUERY) {
        const result = await svc.proxyAttestationReport(query);
        return { status: result.status, text: await result.text() };
      }

      const firstEntry = (text: string) =>
        (JSON.parse(text) as { model_attestations: Record<string, unknown>[] })
          .model_attestations[0];

      const service = () => new AttestationService(makeConfig({ NEAR_AI_API_KEY: 'k' }));

      it('POSTs nvidia_payload verbatim, with nothing else, to NRAS', async () => {
        nearAnswers();
        const tokens = [['JWT', token('a')], { 'GPU-0': token('a') }];
        nvidiaAnswers(tokens, [signingKey('a')]);

        await tap(service());

        const [, init] = nrasMock.mock.calls[0] as [string, RequestInit];
        expect(init.method).toBe('POST');
        expect(init.body).toBe(PAYLOAD);
        expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
      });

      it('attaches the tokens verbatim and only the signing key, x5c intact', async () => {
        nearAnswers();
        const tokens = [['JWT', token('a')], { 'GPU-0': token('a'), 'GPU-1': token('a') }];
        const key = signingKey('a');
        nvidiaAnswers(tokens, [signingKey('other-1'), key, signingKey('other-2')]);

        const { status, text } = await tap(service());

        const entry = firstEntry(text);
        expect(status).toBe(200);
        expect(entry.nvidia_attestation).toEqual({ tokens, keys: [key] });
        expect(entry.nvidia_payload).toBe(PAYLOAD);
        expect(entry.intel_quote).toBe('Q');
      });

      it('relays one key per distinct kid across the tokens', async () => {
        nearAnswers();
        const tokens = [['JWT', token('a')], { 'GPU-0': token('b'), 'GPU-1': token('a') }];
        const [a, b] = [signingKey('a'), signingKey('b')];
        nvidiaAnswers(tokens, [a, signingKey('other'), b]);

        const { text } = await tap(service());

        expect(firstEntry(text).nvidia_attestation).toEqual({ tokens, keys: [a, b] });
      });

      it('relays a signed false the same as a signed true: it never reads a claim', async () => {
        nearAnswers();
        const tokens = [['JWT', token('a', 'x-nvidia-overall-att-result=false')], {}];
        const key = signingKey('a');
        nvidiaAnswers(tokens, [key]);

        const { text } = await tap(service());

        expect(firstEntry(text).nvidia_attestation).toEqual({ tokens, keys: [key] });
      });

      describe('any NVIDIA failure leaves the report byte-identical', () => {
        const unusable: [string, () => Promise<globalThis.Response>][] = [
          ['a 429', () => Promise.resolve(json({ message: 'slow down' }, 429))],
          ['a 500', () => Promise.resolve(json({ message: 'boom' }, 500))],
          ['a dropped connection', () => Promise.reject(new TypeError('fetch failed'))],
          ['a body that is not JSON', () => Promise.resolve(json('<html>'))],
          ['an object body', () => Promise.resolve(json({ ok: true }))],
          ['a one-element array', () => Promise.resolve(json([['JWT', token('a')]]))],
          ['a non-JWT first entry', () => Promise.resolve(json([['X', token('a')], {}]))],
          ['a GPU map of non-strings', () => Promise.resolve(json([['JWT', 'x'], { 'GPU-0': 1 }]))],
          ['tokens that are not JWS', () => Promise.resolve(json([['JWT', 'nope'], {}]))],
        ];

        it.each(unusable)('NRAS answers with %s', async (_name, answer) => {
          nearAnswers();
          nrasMock.mockImplementation(answer);
          jwksMock.mockImplementation(() => Promise.resolve(json({ keys: [signingKey('a')] })));

          const { status, text } = await tap(service());

          expect(status).toBe(200);
          expect(text).toBe(REPORT);
        });

        it('the JWKS fetch fails', async () => {
          nearAnswers();
          nrasMock.mockImplementation(() => Promise.resolve(json([['JWT', token('a')], {}])));
          jwksMock.mockImplementation(() => Promise.resolve(json({}, 503)));

          const { status, text } = await tap(service());

          expect(status).toBe(200);
          expect(text).toBe(REPORT);
        });

        it('no published key matches the token', async () => {
          nearAnswers();
          nvidiaAnswers([['JWT', token('gone')], {}], [signingKey('a')]);

          const { status, text } = await tap(service());

          expect(status).toBe(200);
          expect(text).toBe(REPORT);
        });
      });

      it('leaves a report it does not recognise alone, and calls nobody', async () => {
        for (const body of ['not json', 'null', '{"ok":true}', '{"model_attestations":"nope"}']) {
          nearAnswers(body);
          const { text } = await tap(service());
          expect(text).toBe(body);
        }
        expect(nrasMock).not.toHaveBeenCalled();
      });

      describe('entry selection', () => {
        const two = (first: object, second: object) =>
          JSON.stringify({ model_attestations: [first, second] });

        it('relays only model_attestations[0], the one the app reads', async () => {
          nearAnswers(two({ nvidia_payload: PAYLOAD }, { nvidia_payload: 'second' }));
          nvidiaAnswers([['JWT', token('a')], {}], [signingKey('a')]);

          const { text } = await tap(service());

          const entries = (JSON.parse(text) as { model_attestations: Record<string, unknown>[] })
            .model_attestations;
          expect(nrasMock).toHaveBeenCalledTimes(1);
          expect(entries[0].nvidia_attestation).toBeDefined();
          expect(entries[1].nvidia_attestation).toBeUndefined();
        });

        it.each([
          ['has no payload', {}],
          ['has an empty payload', { nvidia_payload: '' }],
          ['has a non-string payload', { nvidia_payload: { nonce: 'abc' } }],
        ])('calls nobody when the first entry %s', async (_name, first) => {
          const body = two(first, { nvidia_payload: PAYLOAD });
          nearAnswers(body);

          const { text } = await tap(service());

          expect(nrasMock).not.toHaveBeenCalled();
          expect(text).toBe(body);
        });
      });

      it.each(['model=x&nonce=', 'nonce=&model=x', 'model=x&nonce=&a=1'])(
        'does not relay for the empty nonce in %s, and still returns the full report',
        async (query) => {
          nearAnswers();

          const { text } = await tap(service(), query);

          expect(nrasMock).not.toHaveBeenCalled();
          expect(text).toBe(REPORT);
        },
      );

      describe('budget', () => {
        const timeouts = () => (AbortSignal.timeout as jest.Mock).mock.calls.map(([ms]) => ms);

        beforeEach(() => {
          jest.spyOn(AbortSignal, 'timeout');
        });

        it('gives NVIDIA the full 8s when NEAR was quick', async () => {
          nearAnswers();
          nvidiaAnswers([['JWT', token('a')], {}], [signingKey('a')]);

          await tap(service());

          expect(timeouts()[0]).toBe(8_000);
        });

        it('trims the budget so the report lands by 27s', async () => {
          nearAnswers(REPORT, 24_000);
          nvidiaAnswers([['JWT', token('a')], {}], [signingKey('a')]);

          await tap(service());

          expect(timeouts()[0]).toBe(3_000);
        });

        it.each([27_000, 29_999])(
          'creates no timeout and calls nobody when NEAR took %dms',
          async (tookMs) => {
            nearAnswers(REPORT, tookMs);

            const { status, text } = await tap(service());

            expect(timeouts()).toEqual([]);
            expect(nrasMock).not.toHaveBeenCalled();
            expect(status).toBe(200);
            expect(text).toBe(REPORT);
          },
        );

        it('gives up on a hung NRAS at the budget', async () => {
          nearAnswers(REPORT, 26_980);
          nrasMock.mockImplementation(hangsUntilAborted);

          const { status, text } = await tap(service());

          expect(status).toBe(200);
          expect(text).toBe(REPORT);
        });

        it('gives up on a hung JWKS at the budget, though jose holds no signal of ours', async () => {
          nearAnswers(REPORT, 26_980);
          nrasMock.mockImplementation(() => Promise.resolve(json([['JWT', token('a')], {}])));
          jwksMock.mockImplementation(() => new Promise(() => undefined));

          const { status, text } = await tap(service());

          expect(jwksMock).toHaveBeenCalledTimes(1);
          expect(status).toBe(200);
          expect(text).toBe(REPORT);
        });
      });

      describe('JWKS cache', () => {
        const HOUR = 60 * 60 * 1000;

        it('fetches the set once across taps', async () => {
          nearAnswers();
          nvidiaAnswers([['JWT', token('a')], {}], [signingKey('a')]);
          const svc = service();

          await tap(svc);
          await tap(svc);

          expect(nrasMock).toHaveBeenCalledTimes(2);
          expect(jwksMock).toHaveBeenCalledTimes(1);
        });

        it('shares one fetch between concurrent taps', async () => {
          nearAnswers();
          nvidiaAnswers([['JWT', token('a')], {}], [signingKey('a')]);
          const svc = service();

          await Promise.all([tap(svc), tap(svc), tap(svc)]);

          expect(jwksMock).toHaveBeenCalledTimes(1);
        });

        it('refetches once the set is an hour old', async () => {
          nearAnswers();
          nvidiaAnswers([['JWT', token('a')], {}], [signingKey('a')]);
          const svc = service();

          await tap(svc);
          now += HOUR - 1;
          await tap(svc);
          expect(jwksMock).toHaveBeenCalledTimes(1);

          now += 1;
          await tap(svc);
          expect(jwksMock).toHaveBeenCalledTimes(2);
        });

        it('refetches on an unknown kid and relays the new key', async () => {
          nearAnswers();
          nvidiaAnswers([['JWT', token('a')], {}], [signingKey('a')]);
          const svc = service();
          await tap(svc);

          now += 31_000; // past jose's 30s cooldown
          const rotated = signingKey('b');
          const tokens = [['JWT', token('b')], {}];
          nvidiaAnswers(tokens, [rotated]);
          const { text } = await tap(svc);

          expect(jwksMock).toHaveBeenCalledTimes(2);
          expect(firstEntry(text).nvidia_attestation).toEqual({ tokens, keys: [rotated] });
        });

        it('holds off refetching inside the cooldown, and leaves the field out', async () => {
          nearAnswers();
          nvidiaAnswers([['JWT', token('a')], {}], [signingKey('a')]);
          const svc = service();
          await tap(svc);

          now += 1_000;
          nvidiaAnswers([['JWT', token('b')], {}], [signingKey('b')]);
          const { text } = await tap(svc);

          expect(jwksMock).toHaveBeenCalledTimes(1);
          expect(text).toBe(REPORT);
        });
      });

      describe('per-instance cap', () => {
        const tapMany = async (svc: AttestationService, count: number) => {
          for (let i = 0; i < count; i += 1) await tap(svc);
        };

        it('allows 60 NRAS calls a minute, then returns the raw report', async () => {
          nearAnswers();
          nvidiaAnswers([['JWT', token('a')], {}], [signingKey('a')]);
          const svc = service();

          await tapMany(svc, 60);
          const { status, text } = await tap(svc);

          expect(nrasMock).toHaveBeenCalledTimes(60);
          expect(status).toBe(200);
          expect(text).toBe(REPORT);
        });

        it('opens again in the next minute', async () => {
          nearAnswers();
          nvidiaAnswers([['JWT', token('a')], {}], [signingKey('a')]);
          const svc = service();
          await tapMany(svc, 61);

          now += 60_000;
          const { text } = await tap(svc);

          expect(nrasMock).toHaveBeenCalledTimes(61);
          expect(firstEntry(text).nvidia_attestation).toBeDefined();
        });

        it('counts per instance', async () => {
          nearAnswers();
          nvidiaAnswers([['JWT', token('a')], {}], [signingKey('a')]);

          await tapMany(service(), 61);
          const { text } = await tap(service());

          expect(firstEntry(text).nvidia_attestation).toBeDefined();
        });
      });

      describe('logging', () => {
        const logged = () =>
          [
            Logger.prototype.log,
            Logger.prototype.warn,
            Logger.prototype.debug,
            Logger.prototype.error,
          ]
            .flatMap((method) => (method as jest.Mock).mock.calls)
            .join(' ');

        it('logs status and timing, never a token', async () => {
          nearAnswers();
          nvidiaAnswers([['JWT', token('a')], { 'GPU-0': token('a') }], [signingKey('a')]);

          await tap(service());

          expect(logged()).toContain('nrasStatus=200');
          expect(logged()).not.toContain(token('a'));
          expect(logged()).not.toContain('eyJ');
        });

        it("never logs NRAS's error body, which echoes what it was sent", async () => {
          nearAnswers();
          nrasMock.mockImplementation(() =>
            Promise.resolve(json({ message: 'JSON parse error near evidence-echo' }, 400)),
          );

          await tap(service());

          expect(logged()).toContain('nrasStatus=400');
          expect(logged()).not.toContain('evidence-echo');
        });

        it('never logs the text of an unparseable NRAS body', async () => {
          nearAnswers();
          nrasMock.mockImplementation(() => Promise.resolve(json('body-echo-not-json')));

          await tap(service());

          expect(logged()).toContain('SyntaxError');
          expect(logged()).not.toContain('body-echo');
        });
      });
    });
  });
});
