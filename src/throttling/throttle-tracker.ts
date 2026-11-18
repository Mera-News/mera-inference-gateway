// Rate-limit bucket selection.
//
// WHY THIS EXISTS: @nestjs/throttler's default tracker is `req.ip`, which is
// wrong here twice over. `trust proxy` is not set (see main.ts), so Express
// reports the socket peer rather than the client, and even a correct client IP
// would collapse thousands of mobile users behind one carrier NAT address into
// a single bucket. Buckets are keyed by the authenticated principal instead.
//
// ──────────────────────────────────────────────────────────────────────────
// SECURITY: THE SIGNATURE CHECK BELOW SELECTS A COUNTER AND GRANTS NOTHING.
//
// ThrottlerGuard is a global APP_GUARD; AuthGuard is controller-scoped, and
// Nest runs global guards first. So `request.user` does not exist yet when a
// bucket has to be chosen. For JWTs the tracker verifies the SIGNATURE only
// (same key set as AuthGuard, expiry and claims ignored) and reads `sub` from
// a token that passed. A token that fails, or carries no subject, lands in the
// IP bucket, so a forged token naming someone else's `sub` cannot spend that
// user's bucket. An expired but genuine token keeps its own bucket. Nothing
// here is ever written to `request.user` or read by any handler.
//
// Capability tokens are verified for real: CapabilityTokenService.verify() is
// a local HMAC-SHA256 with no network call. /results polling is the dominant
// burst traffic and is capability authed.
// ──────────────────────────────────────────────────────────────────────────

import { compactVerify, type CompactVerifyGetKey } from 'jose';
import type { CapabilityTokenService } from '../auth/capability-token.service';
import { CAPABILITY_TOKEN_PREFIX } from '../auth/capability-token.service';

/** Bucket namespaces. Distinct prefixes so a userId can never collide with an
 *  IP string (a user literally named `127.0.0.1` shares nobody's bucket). */
export const USER_BUCKET_PREFIX = 'u:';
export const IP_BUCKET_PREFIX = 'ip:';

/** Refuse to parse anything larger than a sane JWT. A bearer header is
 *  attacker-controlled and arrives before any auth check. */
const MAX_TOKEN_BYTES = 8192;

function bearerToken(req: { headers?: Record<string, unknown> }): string | null {
  const header = req.headers?.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  if (token.length === 0 || token.length > MAX_TOKEN_BYTES) return null;
  return token;
}

async function verifiedSubject(token: string, keys: CompactVerifyGetKey): Promise<string | null> {
  try {
    const { payload } = await compactVerify(token, keys, { algorithms: ['EdDSA'] });
    const claims = JSON.parse(new TextDecoder().decode(payload)) as {
      sub?: unknown;
      userId?: unknown;
    };
    const id = typeof claims.sub === 'string' ? claims.sub : claims.userId;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * Build the throttler's `getTracker`. Returns `u:<id>` when the bearer token
 * has a valid signature or is a valid capability token, `ip:<addr>` otherwise.
 *
 * An EXPIRED capability token yields no principal (verify() rejects on `exp`)
 * and so falls back to the IP bucket. Those requests 401 at AuthGuard anyway,
 * but they share one bucket, so a fleet of clients waking with expired tokens
 * can rate-limit each other's retries. Expected, not a bug.
 */
export function createThrottleTracker(
  capabilityTokens: Pick<CapabilityTokenService, 'verify'>,
  keys: CompactVerifyGetKey,
): (req: Record<string, unknown>) => Promise<string> {
  return async (req: Record<string, unknown>): Promise<string> => {
    const request = req as { headers?: Record<string, unknown>; ip?: unknown };
    const token = bearerToken(request);

    if (token) {
      if (token.startsWith(CAPABILITY_TOKEN_PREFIX)) {
        // Real HMAC verification: local, no network, microseconds.
        const claims = capabilityTokens.verify(token);
        if (claims?.uid) return `${USER_BUCKET_PREFIX}${claims.uid}`;
      } else {
        const subject = await verifiedSubject(token, keys);
        if (subject) return `${USER_BUCKET_PREFIX}${subject}`;
      }
    }

    const ip = typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : 'unknown';
    return `${IP_BUCKET_PREFIX}${ip}`;
  };
}
