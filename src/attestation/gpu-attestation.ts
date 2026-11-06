import { Logger } from '@nestjs/common';
import { createRemoteJWKSet, decodeProtectedHeader } from 'jose';

const NRAS_ATTEST_URL = 'https://nras.attestation.nvidia.com/v4/attest/gpu';
const NRAS_JWKS_URL = 'https://nras.attestation.nvidia.com/.well-known/jwks.json';

/** The app gives up 30s after sending (mera-app e2ee-service `fetchWithTimeout`):
 *  stopping here leaves 3s for its link, TLS and auth. */
const REPORT_DEADLINE_MS = 27_000;

/** About 2s measured with a cold JWKS, so this only ever trims a stuck NVIDIA. */
const NVIDIA_BUDGET_MS = 8_000;

/** A kid's key never changes and the app checks the chain itself, so a longer
 *  age costs nothing, and taps are rare enough that a short one misses on most. */
const JWKS_MAX_AGE_MS = 60 * 60 * 1000;

/** A tap is one person checking by hand, so one a second per instance is far past
 *  real use. This stops a token holder from hammering NVIDIA from our address. */
const MAX_ATTEST_CALLS_PER_WINDOW = 60;
const ATTEST_WINDOW_MS = 60 * 1000;

/** NVIDIA's response body: the overall token, then one token per GPU. */
type NrasTokens = [['JWT', string], Record<string, string>];

interface ReportShape {
  model_attestations?: { nvidia_payload?: unknown; nvidia_attestation?: unknown }[];
}

function isNrasTokens(body: unknown): body is NrasTokens {
  if (!Array.isArray(body) || body.length !== 2) return false;
  const [overall, gpus] = body as unknown[];
  return (
    Array.isArray(overall) &&
    overall[0] === 'JWT' &&
    typeof overall[1] === 'string' &&
    typeof gpus === 'object' &&
    gpus !== null &&
    !Array.isArray(gpus) &&
    Object.values(gpus).every((token) => typeof token === 'string')
  );
}

/** jose's fetch takes no signal, so the request stops waiting at its own deadline
 *  while the fetch runs on in the background and warms the cache. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      signal.throwIfAborted();
      signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
    }),
  ]);
}

/**
 * Attaches NVIDIA's signed GPU verdict to a nonce'd attestation report, so the
 * app can verify it without phones contacting NVIDIA.
 *
 * The gateway is untrusted here: it relays and never decides. NVIDIA answers 200
 * with a signed `false` for bad evidence, so nothing here reads a claim. Any
 * failure hands back the report exactly as NEAR sent it. Only `nvidia_payload`
 * content leaves: that string is NRAS's request body, verbatim.
 */
export class GpuAttestationRelay {
  private readonly logger = new Logger(GpuAttestationRelay.name);
  private readonly jwks = createRemoteJWKSet(new URL(NRAS_JWKS_URL), {
    cacheMaxAge: JWKS_MAX_AGE_MS,
    timeoutDuration: NVIDIA_BUDGET_MS,
  });
  private windowStartedAt = 0;
  private windowCalls = 0;

  /** Never throws. `startedAt` is when this report's upstream fetch began. */
  async attach(report: string, startedAt: number): Promise<string> {
    const budgetMs = Math.min(NVIDIA_BUDGET_MS, REPORT_DEADLINE_MS - (Date.now() - startedAt));
    if (budgetMs <= 0) return report;

    const relayStartedAt = Date.now();
    let nrasStatus: number | undefined;
    try {
      const parsed = JSON.parse(report) as ReportShape | null;
      // The app reads only the first entry.
      const entry = parsed?.model_attestations?.[0];
      if (typeof entry?.nvidia_payload !== 'string' || !entry.nvidia_payload) return report;
      if (this.overCap()) {
        this.logger.warn('GPU attestation skipped: instance cap reached');
        return report;
      }

      const signal = AbortSignal.timeout(budgetMs);
      const response = await fetch(NRAS_ATTEST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: entry.nvidia_payload,
        signal,
      });
      nrasStatus = response.status;
      if (response.status !== 200) throw new Error('NRAS refused');

      const tokens: unknown = await response.json();
      if (!isNrasTokens(tokens)) throw new Error('NRAS body not recognised');

      entry.nvidia_attestation = { tokens, keys: await this.signingKeys(tokens, signal) };
      this.logger.log(
        `GPU attestation attached: nrasStatus=${nrasStatus} elapsedMs=${Date.now() - relayStartedAt}`,
      );
      return JSON.stringify(parsed);
    } catch (error) {
      // Name only: a JSON error's message quotes the text that failed to parse,
      // and NRAS's error bodies echo what they were sent.
      this.logger.warn(
        `GPU attestation not attached: error=${(error as Error)?.name} nrasStatus=${nrasStatus} elapsedMs=${Date.now() - relayStartedAt}`,
      );
      return report;
    }
  }

  /** The JWKS entries behind these tokens, verbatim with their `x5c`. NVIDIA
   *  publishes over 200 keys and a phone needs one. */
  private async signingKeys(tokens: NrasTokens, signal: AbortSignal): Promise<unknown[]> {
    const headers = new Map(
      [tokens[0][1], ...Object.values(tokens[1])]
        .map((token) => decodeProtectedHeader(token))
        .map((header) => [header.kid, header] as const),
    );
    for (const header of headers.values()) await untilAborted(this.jwks(header), signal);

    const keys = this.jwks.jwks()?.keys.filter((key) => headers.has(key.kid)) ?? [];
    if (keys.length !== headers.size) throw new Error('NRAS signing key missing');
    return keys;
  }

  private overCap(): boolean {
    const now = Date.now();
    if (now - this.windowStartedAt >= ATTEST_WINDOW_MS) {
      this.windowStartedAt = now;
      this.windowCalls = 0;
    }
    this.windowCalls += 1;
    return this.windowCalls > MAX_ATTEST_CALLS_PER_WINDOW;
  }
}
