// Per-job capability token. HMAC-SHA256 over a compact payload, base64url-
// encoded together with the payload. Lets clients call /jobs/:id/results and
// POST follow-up phase-2 jobs without ever sending the user's session JWT
// from a background context (where the keychain is unavailable post-reboot).
//
// Format: `mc.<payload-b64url>.<sig-b64url>`. The `mc.` prefix identifies a
// capability token at parse time so AuthGuard can route it without trying
// JWKS verification first. Payload is JSON: { uid, rid, exp, scopes }.

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

export const CAPABILITY_TOKEN_PREFIX = 'mc.';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export type CapabilityScope = 'results:read' | 'jobs:submit-followup';

export interface CapabilityClaims {
  /** userId — must match the user that originally submitted the job. */
  uid: string;
  /** requestId the token is bound to. `null` only when the token is meant to
   *  cover a follow-up submission (phase-2) where the new requestId hasn't
   *  been minted yet. We always issue tokens with `rid` set today. */
  rid: string;
  /** Unix ms expiration. */
  exp: number;
  /** Authorized scopes. Both `results:read` and `jobs:submit-followup` are
   *  granted at mint time so phase-2 chaining works without a re-mint. */
  scopes: CapabilityScope[];
}

@Injectable()
export class CapabilityTokenService implements OnModuleInit {
  private readonly logger = new Logger(CapabilityTokenService.name);
  private secret!: Buffer;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const hex = this.configService.get<string>('INFERENCE_CAPABILITY_SECRET');
    if (!hex || hex.length < 32) {
      throw new Error(
        'INFERENCE_CAPABILITY_SECRET must be set to a hex string of at least 32 chars (16 bytes)',
      );
    }
    this.secret = Buffer.from(hex, 'hex');
    if (this.secret.length < 16) {
      throw new Error('INFERENCE_CAPABILITY_SECRET must decode to at least 16 bytes');
    }
  }

  mint(args: { userId: string; requestId: string; ttlMs?: number }): string {
    const claims: CapabilityClaims = {
      uid: args.userId,
      rid: args.requestId,
      exp: Date.now() + (args.ttlMs ?? DEFAULT_TTL_MS),
      scopes: ['results:read', 'jobs:submit-followup'],
    };
    const payload = b64urlEncode(Buffer.from(JSON.stringify(claims)));
    const sig = this.sign(payload);
    return `${CAPABILITY_TOKEN_PREFIX}${payload}.${sig}`;
  }

  /** Verify a candidate token. Returns claims on success, null on any
   *  failure mode — caller maps null to UnauthorizedException. */
  verify(token: string): CapabilityClaims | null {
    if (!token.startsWith(CAPABILITY_TOKEN_PREFIX)) return null;
    const body = token.slice(CAPABILITY_TOKEN_PREFIX.length);
    const dot = body.indexOf('.');
    if (dot <= 0) return null;
    const payload = body.slice(0, dot);
    const sig = body.slice(dot + 1);

    const expected = this.sign(payload);
    if (!safeEqual(sig, expected)) return null;

    let claims: CapabilityClaims;
    try {
      claims = JSON.parse(b64urlDecode(payload).toString('utf8')) as CapabilityClaims;
    } catch {
      return null;
    }
    if (typeof claims.uid !== 'string' || claims.uid.length === 0) return null;
    if (typeof claims.rid !== 'string' || claims.rid.length === 0) return null;
    if (typeof claims.exp !== 'number' || claims.exp <= Date.now()) return null;
    if (!Array.isArray(claims.scopes)) return null;
    return claims;
  }

  private sign(payload: string): string {
    return b64urlEncode(createHmac('sha256', this.secret).update(payload).digest());
  }
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
