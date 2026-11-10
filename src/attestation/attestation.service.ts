import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PROVIDERS, type Provider } from '../constants';
import { GpuAttestationRelay } from './gpu-attestation';

interface CachedAttestation {
  status: number;
  body: string;
  contentType: string | null;
  fetchedAt: number;
}

/**
 * TTL for the in-memory attestation cache, keyed by the exact query string.
 *
 * The CLIENT already caches the attestation report for 30 minutes in memory,
 * so caching it here for 10 minutes on the server does not change the
 * security posture at all -- it only collapses redundant upstream fetches
 * across concurrent app-launches/users within the window (every launch
 * otherwise pays the full upstream round-trip to NEAR AI).
 */
const ATTESTATION_CACHE_TTL_MS = 10 * 60 * 1000;

/** model x algo combinations are few -- bound the map defensively and evict
 *  the oldest entry on overflow. */
const ATTESTATION_CACHE_MAX_ENTRIES = 20;

/**
 * The fields the app's HOT PATH reads from a model attestation entry
 * (mera-app lib/e2ee/e2ee-service `fetchModelPublicKeyUncached`: the signing
 * key it encrypts toward, its algo, and the signing address it records).
 *
 * The full upstream report is ~312KB per model: `intel_quote` (10KB),
 * `nvidia_payload` (~98KB) and `info.app_compose` (~40KB), twice over (model
 * attestation + gateway attestation). The app fetches three of them on every
 * cold launch (primary + both fallbacks) before it can encrypt the first chat
 * turn, over the user's mobile link, and reads 64 bytes of each. Only the
 * user-initiated verify tap consumes the quote and the GPU payload, and that
 * fetch always carries a `nonce` -- so a nonce-free request gets the slim
 * projection and a nonce'd request gets the full report, plus NVIDIA's signed
 * GPU verdict when NVIDIA answers in time (see gpu-attestation.ts). Nothing
 * about the E2EE posture changes: the key material is passed through untouched.
 */
const HOT_PATH_ATTESTATION_FIELDS = [
  'model_name',
  'signing_address',
  'signing_algo',
  'signing_public_key',
  'request_nonce',
  // The app verifies the quote on the hot path, fail-closed; without it every key is rejected.
  'intel_quote',
] as const;

function pickFields(entry: unknown): Record<string, unknown> | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const source = entry as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of HOT_PATH_ATTESTATION_FIELDS) {
    if (source[field] !== undefined) out[field] = source[field];
  }
  return out;
}

/** Project a 200 report body down to the hot-path fields. Anything that is
 *  not the expected shape (non-JSON, no `model_attestations` array) is
 *  returned verbatim so a changed upstream format degrades to the old
 *  behaviour, never to a broken client. */
export function slimAttestationForHotPath(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (typeof parsed !== 'object' || parsed === null) return body;
  const report = parsed as Record<string, unknown>;
  if (!Array.isArray(report.model_attestations)) return body;

  const slim: Record<string, unknown> = {
    model_attestations: report.model_attestations
      .map(pickFields)
      .filter((e): e is Record<string, unknown> => e !== null),
  };
  const gateway = pickFields(report.gateway_attestation);
  // Only the model's quote is verified; the gateway entry stays slim.
  if (gateway) delete gateway.intel_quote;
  if (gateway) slim.gateway_attestation = gateway;
  return JSON.stringify(slim);
}

/** A nonce'd fetch is the verify tap: it needs the quote and GPU payload. */
function requestsFullReport(queryString: string): boolean {
  return /(^|&)nonce=/.test(queryString);
}

/** NVIDIA's verdict is bound to the nonce, so an empty one has nothing to prove. */
function carriesNonce(queryString: string): boolean {
  return /(^|&)nonce=[^&]/.test(queryString);
}

@Injectable()
export class AttestationService {
  private readonly logger = new Logger(AttestationService.name);
  private readonly apiKey: string;
  private readonly cache = new Map<string, CachedAttestation>();
  private readonly gpuAttestation = new GpuAttestationRelay();

  constructor(private configService: ConfigService) {
    const key = this.configService.get<string>('NEAR_AI_API_KEY', '');
    if (!key) {
      throw new Error('NEAR_AI_API_KEY environment variable is not set');
    }
    this.apiKey = key;
  }

  /** Proxy (with a short-lived cache): forward query params as-is to the
   *  attestation endpoint. Only nonce-free 200 responses are cached; everything
   *  else passes through uncached, and non-200s unbuffered. */
  async proxyAttestationReport(
    queryString: string,
    provider: Provider = 'near',
  ): Promise<globalThis.Response> {
    // Provider is part of the key: the same ?model= query is a different report per provider.
    const cacheKey = `${provider}:${queryString}`;
    const apiKey =
      provider === 'near'
        ? this.apiKey
        : this.configService.get<string>(PROVIDERS[provider].keyEnv, '');
    if (!apiKey) throw new Error(`${provider} API key is not set`);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      const ageMs = Date.now() - cached.fetchedAt;
      if (ageMs < ATTESTATION_CACHE_TTL_MS) {
        this.logger.debug(`Attestation cache hit (ageMs=${ageMs})`);
        return this.toResponse(cached);
      }
      this.cache.delete(cacheKey);
    }
    this.logger.debug('Attestation cache miss');

    const url = `${PROVIDERS[provider].baseUrl}/attestation/report${queryString ? `?${queryString}` : ''}`;
    this.logger.debug(`Proxying attestation report: ${url}`);

    const controller = new AbortController();
    const timeoutMs = 30_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const upstream = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      const elapsedMs = Date.now() - startedAt;
      this.logger.log(
        `Upstream attestation fetch: status=${upstream.status} elapsedMs=${elapsedMs}`,
      );

      if (upstream.status !== 200) {
        return upstream;
      }

      const rawBody = await upstream.text();
      const fullReport = requestsFullReport(queryString);
      let body = fullReport ? rawBody : slimAttestationForHotPath(rawBody);
      if (carriesNonce(queryString)) {
        body = await this.gpuAttestation.attach(rawBody, startedAt);
      }
      const contentType = upstream.headers.get('content-type');
      const entry: CachedAttestation = {
        status: upstream.status,
        body,
        contentType,
        fetchedAt: Date.now(),
      };
      // A nonce is single-use, so a stored report could only ever be a stale replay.
      if (!fullReport) this.setCache(cacheKey, entry);
      return this.toResponse(entry);
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') {
        throw new Error(`Upstream attestation timeout after ${timeoutMs}ms (url=${url})`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private toResponse(entry: CachedAttestation): globalThis.Response {
    return new Response(entry.body, {
      status: entry.status,
      headers: entry.contentType ? { 'content-type': entry.contentType } : undefined,
    });
  }

  private setCache(key: string, entry: CachedAttestation): void {
    // Delete-then-set so re-caching an existing key also refreshes its
    // position for FIFO eviction purposes.
    this.cache.delete(key);
    this.cache.set(key, entry);
    if (this.cache.size > ATTESTATION_CACHE_MAX_ENTRIES) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
  }
}
