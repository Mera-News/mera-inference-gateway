import {
  createThrottleTracker,
  decodeJwtSubjectUnverified,
  IP_BUCKET_PREFIX,
  USER_BUCKET_PREFIX,
} from './throttle-tracker';
import { CAPABILITY_TOKEN_PREFIX } from '../auth/capability-token.service';

/** Build an UNSIGNED JWT-shaped string with the given payload. */
function jwtLike(payload: Record<string, unknown>, signature = 'not-a-real-signature'): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  return `${b64({ alg: 'EdDSA' })}.${b64(payload)}.${signature}`;
}

function req(authorization?: string, ip = '10.0.0.1') {
  return { headers: authorization ? { authorization } : {}, ip } as Record<string, unknown>;
}

describe('decodeJwtSubjectUnverified', () => {
  it('reads the sub claim', () => {
    expect(decodeJwtSubjectUnverified(jwtLike({ sub: 'user-1' }))).toBe('user-1');
  });

  it('falls back to the legacy userId claim', () => {
    expect(decodeJwtSubjectUnverified(jwtLike({ userId: 'user-2' }))).toBe('user-2');
  });

  it('prefers sub over userId', () => {
    expect(decodeJwtSubjectUnverified(jwtLike({ sub: 'a', userId: 'b' }))).toBe('a');
  });

  it.each([
    ['not a jwt', 'garbage'],
    ['too few segments', 'a.b'],
    ['payload is not base64 json', 'a.!!!!.c'],
    ['no subject claim', jwtLike({ foo: 'bar' })],
    ['empty subject', jwtLike({ sub: '' })],
    ['non-string subject', jwtLike({ sub: 42 })],
  ])('returns null for %s', (_label, token) => {
    expect(decodeJwtSubjectUnverified(token)).toBeNull();
  });
});

describe('createThrottleTracker', () => {
  const verify = jest.fn();
  const tracker = createThrottleTracker({ verify });

  beforeEach(() => verify.mockReset());

  describe('IP fallback', () => {
    it('uses the ip bucket with no Authorization header', () => {
      expect(tracker(req())).toBe(`${IP_BUCKET_PREFIX}10.0.0.1`);
    });

    it('uses the ip bucket for a non-Bearer scheme', () => {
      expect(tracker(req('Basic abc'))).toBe(`${IP_BUCKET_PREFIX}10.0.0.1`);
    });

    it('uses the ip bucket for an unparseable bearer token', () => {
      expect(tracker(req('Bearer garbage'))).toBe(`${IP_BUCKET_PREFIX}10.0.0.1`);
    });

    it('substitutes "unknown" when req.ip is absent', () => {
      expect(tracker({ headers: {} })).toBe(`${IP_BUCKET_PREFIX}unknown`);
    });

    it('refuses to parse an oversized bearer token', () => {
      const huge = `Bearer ${'x'.repeat(9000)}`;
      expect(tracker(req(huge))).toBe(`${IP_BUCKET_PREFIX}10.0.0.1`);
    });
  });

  describe('JWT bucketing (decode is NOT verification)', () => {
    it('buckets by the sub claim', () => {
      expect(tracker(req(`Bearer ${jwtLike({ sub: 'user-1' })}`))).toBe(
        `${USER_BUCKET_PREFIX}user-1`,
      );
    });

    // Pins the accepted trade-off so it is visible in the suite rather than
    // silent: bucketing trusts the claimed sub without checking the signature.
    // This grants NOTHING -- AuthGuard still rejects the request with a 401.
    it('buckets a token with a garbage signature by its claimed sub', () => {
      const forged = jwtLike({ sub: 'victim' }, 'AAAA-forged-AAAA');
      expect(tracker(req(`Bearer ${forged}`))).toBe(`${USER_BUCKET_PREFIX}victim`);
    });

    it('never consults the capability verifier for a JWT', () => {
      tracker(req(`Bearer ${jwtLike({ sub: 'user-1' })}`));
      expect(verify).not.toHaveBeenCalled();
    });

    it('two different users land in two different buckets', () => {
      const a = tracker(req(`Bearer ${jwtLike({ sub: 'a' })}`));
      const b = tracker(req(`Bearer ${jwtLike({ sub: 'b' })}`));
      expect(a).not.toBe(b);
    });

    it('the same user on two different IPs shares one bucket', () => {
      const token = `Bearer ${jwtLike({ sub: 'same' })}`;
      expect(tracker(req(token, '1.1.1.1'))).toBe(tracker(req(token, '2.2.2.2')));
    });
  });

  describe('capability tokens (really verified)', () => {
    const capToken = `${CAPABILITY_TOKEN_PREFIX}payload.signature`;

    it('buckets by uid when the HMAC verifies', () => {
      verify.mockReturnValue({ uid: 'user-9', rid: 'r', exp: Date.now() + 1000, scopes: [] });
      expect(tracker(req(`Bearer ${capToken}`))).toBe(`${USER_BUCKET_PREFIX}user-9`);
      expect(verify).toHaveBeenCalledWith(capToken);
    });

    // An expired token fails verify(), so no principal can be recovered and
    // the request falls to the shared IP bucket. Documented in the skill.
    it('falls back to the ip bucket when verification fails (expired or forged)', () => {
      verify.mockReturnValue(null);
      expect(tracker(req(`Bearer ${capToken}`))).toBe(`${IP_BUCKET_PREFIX}10.0.0.1`);
    });

    it('falls back to the ip bucket when claims carry no uid', () => {
      verify.mockReturnValue({ uid: '', rid: 'r', exp: Date.now() + 1000, scopes: [] });
      expect(tracker(req(`Bearer ${capToken}`))).toBe(`${IP_BUCKET_PREFIX}10.0.0.1`);
    });

    it('does not try to JWT-decode a capability token', () => {
      verify.mockReturnValue(null);
      tracker(req(`Bearer ${capToken}`));
      expect(verify).toHaveBeenCalledTimes(1);
    });
  });

  it('a userId that looks like an IP cannot collide with an IP bucket', () => {
    const asUser = tracker(req(`Bearer ${jwtLike({ sub: '10.0.0.1' })}`));
    const asIp = tracker(req(undefined, '10.0.0.1'));
    expect(asUser).not.toBe(asIp);
  });
});
