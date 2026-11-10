/** Upstream inference endpoint. The gateway is a pure proxy — it never
 *  inspects ciphertext, only forwards requests and replies. */
export const UPSTREAM_BASE_URL = 'https://cloud-api.near.ai/v1';

/** Expected JWT issuer claim — must match the auth service's jwt() plugin config */
export const JWT_ISSUER = 'mera-server-auth';

/** Upstream TEE providers. The app picks one per request with `X-Mera-Provider`
 *  (absent = near, for app builds that predate it). Base URL + key env per provider. */
export const PROVIDERS = {
  near: { baseUrl: UPSTREAM_BASE_URL, keyEnv: 'NEAR_AI_API_KEY' },
  redpill: { baseUrl: 'https://tee.redpill.ai/v1', keyEnv: 'REDPILL_API_KEY' },
} as const;

export type Provider = keyof typeof PROVIDERS;

/** Header value -> provider. Absent is near; anything unknown is null (the caller answers 400). */
export function parseProvider(value: unknown): Provider | null {
  if (value === undefined) return 'near';
  return typeof value === 'string' && Object.hasOwn(PROVIDERS, value) ? (value as Provider) : null;
}
