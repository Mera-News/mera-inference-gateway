/** Upstream inference endpoint. The gateway is a pure proxy — it never
 *  inspects ciphertext, only forwards requests and replies. */
export const UPSTREAM_BASE_URL = 'https://cloud-api.near.ai/v1';

/** Expected JWT issuer claim — must match the auth service's jwt() plugin config */
export const JWT_ISSUER = 'mera-server-auth';
