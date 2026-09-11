// Rate-limit bucket selection.
//
// WHY THIS EXISTS: @nestjs/throttler's default tracker is `req.ip`, which is
// wrong here twice over. `trust proxy` is not set (see main.ts), so Express
// reports the socket peer rather than the client, and even a correct client IP
// would collapse thousands of mobile users behind one carrier NAT address into
// a single bucket. Buckets are keyed by the authenticated principal instead.
//
// ──────────────────────────────────────────────────────────────────────────
// SECURITY: THE JWT DECODE BELOW IS NOT A VERIFICATION AND GRANTS NOTHING.
//
// ThrottlerGuard is a global APP_GUARD; AuthGuard is controller-scoped, and
// Nest runs global guards first. So `request.user` does not exist yet when a
// bucket has to be chosen. For JWTs we therefore read the `sub` claim WITHOUT
// checking the signature. That is safe because it decides one thing only:
// which counter to increment. The request is still fully verified by AuthGuard
// immediately afterwards, and a forged token gets a 401 exactly as before.
// Nothing here is ever written to `request.user` or read by any handler.
//
// Capability tokens do NOT take that shortcut: CapabilityTokenService.verify()
// is a local HMAC-SHA256 with no network call, so it is cheap enough to run
// for real. /results polling is the dominant burst traffic and is capability
// authed, which keeps the unverified path off the high-volume routes.
//
// Residual, accepted: on the JWT routes an attacker who knows a victim's
// userId can aim requests at that victim's bucket and burn it one 401 at a
// time. Closing that needs a verify shared with AuthGuard; see the wave plan.
// ──────────────────────────────────────────────────────────────────────────

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

/**
 * Read `sub` (or the legacy `userId`) out of a JWT WITHOUT verifying it.
 * Bucketing only — see the header note. Returns null on anything unexpected.
 */
export function decodeJwtSubjectUnverified(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1];
    if (!payload) return null;
    const pad = payload.length % 4 === 0 ? '' : '='.repeat(4 - (payload.length % 4));
    const json = Buffer.from(
      payload.replace(/-/g, '+').replace(/_/g, '/') + pad,
      'base64',
    ).toString('utf8');
    const claims = JSON.parse(json) as { sub?: unknown; userId?: unknown };
    const id = typeof claims.sub === 'string' ? claims.sub : claims.userId;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * Build the throttler's `getTracker`. Returns `u:<id>` when the bearer token
 * yields a principal, `ip:<addr>` otherwise.
 *
 * An EXPIRED capability token yields no principal (verify() rejects on `exp`)
 * and so falls back to the IP bucket. Those requests 401 at AuthGuard anyway,
 * but they share one bucket, so a fleet of clients waking with expired tokens
 * can rate-limit each other's retries. Expected, not a bug.
 */
export function createThrottleTracker(
  capabilityTokens: Pick<CapabilityTokenService, 'verify'>,
): (req: Record<string, unknown>) => string {
  return (req: Record<string, unknown>): string => {
    const request = req as { headers?: Record<string, unknown>; ip?: unknown };
    const token = bearerToken(request);

    if (token) {
      if (token.startsWith(CAPABILITY_TOKEN_PREFIX)) {
        // Real HMAC verification: local, no network, microseconds.
        const claims = capabilityTokens.verify(token);
        if (claims?.uid) return `${USER_BUCKET_PREFIX}${claims.uid}`;
      } else {
        const subject = decodeJwtSubjectUnverified(token);
        if (subject) return `${USER_BUCKET_PREFIX}${subject}`;
      }
    }

    const ip = typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : 'unknown';
    return `${IP_BUCKET_PREFIX}${ip}`;
  };
}
