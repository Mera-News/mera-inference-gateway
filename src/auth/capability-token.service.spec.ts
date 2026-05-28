import { ConfigService } from '@nestjs/config';
import { CAPABILITY_TOKEN_PREFIX, CapabilityTokenService } from './capability-token.service';

const TEST_SECRET = 'a'.repeat(64); // 32 bytes hex

function makeConfig(secret?: string): ConfigService {
  return {
    get: <T>(key: string): T | undefined =>
      key === 'INFERENCE_CAPABILITY_SECRET' ? (secret as unknown as T) : undefined,
  } as unknown as ConfigService;
}

function makeService(secret: string = TEST_SECRET): CapabilityTokenService {
  const svc = new CapabilityTokenService(makeConfig(secret));
  svc.onModuleInit();
  return svc;
}

describe('CapabilityTokenService', () => {
  describe('onModuleInit', () => {
    it('throws when secret is missing', () => {
      const svc = new CapabilityTokenService(makeConfig(undefined));
      expect(() => svc.onModuleInit()).toThrow(/INFERENCE_CAPABILITY_SECRET/);
    });

    it('throws when secret is too short', () => {
      const svc = new CapabilityTokenService(makeConfig('abcd'));
      expect(() => svc.onModuleInit()).toThrow(/INFERENCE_CAPABILITY_SECRET/);
    });

    it('throws when secret decodes to fewer than 16 bytes', () => {
      // 32 hex chars but mostly non-hex -> decodes to < 16 bytes
      const svc = new CapabilityTokenService(makeConfig('zz'.repeat(16)));
      expect(() => svc.onModuleInit()).toThrow(/at least 16 bytes/);
    });
  });

  describe('mint -> verify round trip', () => {
    it('returns the original claims', () => {
      const svc = makeService();
      const token = svc.mint({ userId: 'user-1', requestId: 'req-1' });
      expect(token.startsWith(CAPABILITY_TOKEN_PREFIX)).toBe(true);

      const claims = svc.verify(token);
      expect(claims).not.toBeNull();
      expect(claims!.uid).toBe('user-1');
      expect(claims!.rid).toBe('req-1');
      expect(claims!.scopes).toEqual(['results:read', 'jobs:submit-followup']);
      expect(claims!.exp).toBeGreaterThan(Date.now());
    });
  });

  describe('verify failure modes', () => {
    it('rejects an expired token', () => {
      const svc = makeService();
      const token = svc.mint({
        userId: 'user-1',
        requestId: 'req-1',
        ttlMs: -1000,
      });
      expect(svc.verify(token)).toBeNull();
    });

    it('rejects a token without the capability prefix', () => {
      const svc = makeService();
      expect(svc.verify('not-a-capability-token')).toBeNull();
    });

    it('rejects a token with a tampered signature', () => {
      const svc = makeService();
      const token = svc.mint({ userId: 'user-1', requestId: 'req-1' });
      // Flip the last char of the signature.
      const lastChar = token.slice(-1) === 'A' ? 'B' : 'A';
      const tampered = token.slice(0, -1) + lastChar;
      expect(svc.verify(tampered)).toBeNull();
    });

    it('rejects a token with a tampered payload', () => {
      const svc = makeService();
      const token = svc.mint({ userId: 'user-1', requestId: 'req-1' });
      // Build a forged payload but keep the original signature.
      const body = token.slice(CAPABILITY_TOKEN_PREFIX.length);
      const sig = body.slice(body.indexOf('.') + 1);
      const forgedPayload = Buffer.from(
        JSON.stringify({
          uid: 'attacker',
          rid: 'req-1',
          exp: Date.now() + 100000,
          scopes: ['results:read'],
        }),
      )
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
      const forged = `${CAPABILITY_TOKEN_PREFIX}${forgedPayload}.${sig}`;
      expect(svc.verify(forged)).toBeNull();
    });

    it('rejects a token signed with a different secret', () => {
      const minter = makeService('a'.repeat(64));
      const verifier = makeService('b'.repeat(64));
      const token = minter.mint({ userId: 'user-1', requestId: 'req-1' });
      expect(verifier.verify(token)).toBeNull();
    });

    it('rejects malformed body (no dot separator)', () => {
      const svc = makeService();
      expect(svc.verify(`${CAPABILITY_TOKEN_PREFIX}nodothere`)).toBeNull();
    });
  });

  describe('claim presence enforcement', () => {
    // Helper that signs an arbitrary claims object using the service's own
    // signing so only the claim-validation branch is exercised.
    function forge(svc: CapabilityTokenService, claims: Record<string, unknown>): string {
      const payload = Buffer.from(JSON.stringify(claims))
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
      // Re-mint a real token to extract a valid sig algorithm path is not
      // possible without the secret; instead use the private sign via mint of
      // a known payload is not feasible. So we round-trip through verify by
      // constructing using the same secret: reach into sign through mint.
      const sig = (svc as unknown as { sign: (p: string) => string }).sign(payload);
      return `${CAPABILITY_TOKEN_PREFIX}${payload}.${sig}`;
    }

    it('rejects missing uid', () => {
      const svc = makeService();
      const token = forge(svc, {
        rid: 'req-1',
        exp: Date.now() + 100000,
        scopes: [],
      });
      expect(svc.verify(token)).toBeNull();
    });

    it('rejects missing rid', () => {
      const svc = makeService();
      const token = forge(svc, {
        uid: 'user-1',
        exp: Date.now() + 100000,
        scopes: [],
      });
      expect(svc.verify(token)).toBeNull();
    });

    it('rejects non-array scopes', () => {
      const svc = makeService();
      const token = forge(svc, {
        uid: 'user-1',
        rid: 'req-1',
        exp: Date.now() + 100000,
        scopes: 'results:read',
      });
      expect(svc.verify(token)).toBeNull();
    });

    it('rejects non-numeric exp', () => {
      const svc = makeService();
      const token = forge(svc, {
        uid: 'user-1',
        rid: 'req-1',
        exp: 'soon',
        scopes: [],
      });
      expect(svc.verify(token)).toBeNull();
    });

    it('rejects payload that is not valid JSON', () => {
      const svc = makeService();
      const payload = Buffer.from('not json').toString('base64').replace(/=+$/g, '');
      const sig = (svc as unknown as { sign: (p: string) => string }).sign(payload);
      expect(svc.verify(`${CAPABILITY_TOKEN_PREFIX}${payload}.${sig}`)).toBeNull();
    });
  });

  describe('base64url encode/decode handles padding', () => {
    it('round-trips claims of varying byte lengths (different pad counts)', () => {
      const svc = makeService();
      // Vary userId length so the JSON payload hits each padding remainder.
      for (let n = 1; n < 7; n++) {
        const userId = 'u'.repeat(n);
        const requestId = '507f1f77bcf86cd799439011';
        const token = svc.mint({ userId, requestId });
        const claims = svc.verify(token);
        expect(claims).not.toBeNull();
        expect(claims!.uid).toBe(userId);
        expect(claims!.rid).toBe(requestId);
        // Token must contain no '=' padding (stripped by b64urlEncode).
        expect(token).not.toContain('=');
      }
    });
  });
});
