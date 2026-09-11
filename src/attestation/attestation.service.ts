import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UPSTREAM_BASE_URL } from '../constants';

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
 * projection and a nonce'd request gets the report verbatim. Nothing about
 * the E2EE posture changes: the key material is passed through untouched.
 */
const HOT_PATH_ATTESTATION_FIELDS = [
  'model_name',
  'signing_address',
  'signing_algo',
  'signing_public_key',
  'request_nonce',
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
  if (gateway) slim.gateway_attestation = gateway;
  return JSON.stringify(slim);
}

/** A nonce'd fetch is the verify tap: it needs the quote and GPU payload. */
function requestsFullReport(queryString: string): boolean {
  return /(^|&)nonce=/.test(queryString);
}

@Injectable()
export class AttestationService {
  private readonly logger = new Logger(AttestationService.name);
  private readonly apiKey: string;
  private readonly cache = new Map<string, CachedAttestation>();

  constructor(private configService: ConfigService) {
    const key = this.configService.get<string>('NEAR_AI_API_KEY', '');
    if (!key) {
      throw new Error('NEAR_AI_API_KEY environment variable is not set');
    }
    this.apiKey = key;
  }

  /** Proxy (with a short-lived cache): forward query params as-is to the
   *  attestation endpoint. Only 200 responses are cached; everything else
   *  passes through uncached, unbuffered. */
  async proxyAttestationReport(queryString: string): Promise<globalThis.Response> {
    const cacheKey = queryString;
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

    const url = `${UPSTREAM_BASE_URL}/attestation/report${queryString ? `?${queryString}` : ''}`;
    this.logger.debug(`Proxying attestation report: ${url}`);

    const controller = new AbortController();
    const timeoutMs = 30_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const upstream = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
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
      const body = requestsFullReport(queryString) ? rawBody : slimAttestationForHotPath(rawBody);
      const contentType = upstream.headers.get('content-type');
      const entry: CachedAttestation = {
        status: upstream.status,
        body,
        contentType,
        fetchedAt: Date.now(),
      };
      this.setCache(cacheKey, entry);
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
