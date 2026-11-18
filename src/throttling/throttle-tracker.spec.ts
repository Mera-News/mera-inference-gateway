import { CompactSign, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from 'jose';
import { createThrottleTracker, IP_BUCKET_PREFIX, USER_BUCKET_PREFIX } from './throttle-tracker';
import { CAPABILITY_TOKEN_PREFIX } from '../auth/capability-token.service';

function req(authorization?: string, ip = '10.0.0.1') {
  return { headers: authorization ? { authorization } : {}, ip } as Record<string, unknown>;
}

describe('createThrottleTracker', () => {
  const verify = jest.fn();
  let privateKey: CryptoKey;
  let otherKey: CryptoKey;
  let tracker: ReturnType<typeof createThrottleTracker>;

  /** A compact JWS over `payload`, signed with `key`. */
  const sign = (payload: Record<string, unknown>, key: CryptoKey = privateKey) =>
    new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
      .sign(key);

  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    privateKey = pair.privateKey;
    otherKey = (await generateKeyPair('EdDSA', { crv: 'Ed25519' })).privateKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'EdDSA' };
    tracker = createThrottleTracker({ verify }, createLocalJWKSet({ keys: [jwk] }));
  });

  beforeEach(() => verify.mockReset());

  describe('IP fallback', () => {
    it('uses the ip bucket with no Authorization header', async () => {
      await expect(tracker(req())).resolves.toBe(`${IP_BUCKET_PREFIX}10.0.0.1`);
    });

    it('uses the ip bucket for a non-Bearer scheme', async () => {
      await expect(tracker(req('Basic abc'))).resolves.toBe(`${IP_BUCKET_PREFIX}10.0.0.1`);
    });

    it('uses the ip bucket for an unparseable bearer token', async () => {
      await expect(tracker(req('Bearer garbage'))).resolves.toBe(`${IP_BUCKET_PREFIX}10.0.0.1`);
    });

    it('substitutes "unknown" when req.ip is absent', async () => {
      await expect(tracker({ headers: {} })).resolves.toBe(`${IP_BUCKET_PREFIX}unknown`);
    });

    it('refuses to parse an oversized bearer token', async () => {
      const huge = `Bearer ${'x'.repeat(9000)}`;
      await expect(tracker(req(huge))).resolves.toBe(`${IP_BUCKET_PREFIX}10.0.0.1`);
    });
  });

  describe('JWT bucketing (signature checked, expiry ignored)', () => {
    it('buckets a signed token by its sub claim', async () => {
      const token = await sign({ sub: 'user-1' });
      await expect(tracker(req(`Bearer ${token}`))).resolves.toBe(`${USER_BUCKET_PREFIX}user-1`);
    });

    it('buckets a signed token with only the legacy userId claim', async () => {
      const token = await sign({ userId: 'user-2' });
      await expect(tracker(req(`Bearer ${token}`))).resolves.toBe(`${USER_BUCKET_PREFIX}user-2`);
    });

    it('puts a forged signature in the ip bucket, not the claimed sub', async () => {
      const forged = await sign({ sub: 'victim' }, otherKey);
      await expect(tracker(req(`Bearer ${forged}`))).resolves.toBe(`${IP_BUCKET_PREFIX}10.0.0.1`);
    });

    it('keeps an expired but signed token in its own bucket', async () => {
      const token = await sign({ sub: 'user-3', exp: 1 });
      await expect(tracker(req(`Bearer ${token}`))).resolves.toBe(`${USER_BUCKET_PREFIX}user-3`);
    });

    it('puts a signed token with no subject in the ip bucket', async () => {
      const token = await sign({ foo: 'bar' });
      await expect(tracker(req(`Bearer ${token}`))).resolves.toBe(`${IP_BUCKET_PREFIX}10.0.0.1`);
    });

    it('falls back to the ip bucket when the key set throws', async () => {
      const broken = createThrottleTracker({ verify }, () => {
        throw new Error('key set unreachable');
      });
      const token = await sign({ sub: 'user-4' });
      await expect(broken(req(`Bearer ${token}`))).resolves.toBe(`${IP_BUCKET_PREFIX}10.0.0.1`);
    });

    it('never consults the capability verifier for a JWT', async () => {
      await tracker(req(`Bearer ${await sign({ sub: 'user-1' })}`));
      expect(verify).not.toHaveBeenCalled();
    });

    it('two different users land in two different buckets', async () => {
      const a = await tracker(req(`Bearer ${await sign({ sub: 'a' })}`));
      const b = await tracker(req(`Bearer ${await sign({ sub: 'b' })}`));
      expect(a).not.toBe(b);
    });

    it('the same user on two different IPs shares one bucket', async () => {
      const token = `Bearer ${await sign({ sub: 'same' })}`;
      expect(await tracker(req(token, '1.1.1.1'))).toBe(await tracker(req(token, '2.2.2.2')));
    });
  });

  describe('capability tokens (really verified)', () => {
    const capToken = `${CAPABILITY_TOKEN_PREFIX}payload.signature`;

    it('buckets by uid when the HMAC verifies', async () => {
      verify.mockReturnValue({ uid: 'user-9', rid: 'r', exp: Date.now() + 1000, scopes: [] });
      await expect(tracker(req(`Bearer ${capToken}`))).resolves.toBe(`${USER_BUCKET_PREFIX}user-9`);
      expect(verify).toHaveBeenCalledWith(capToken);
    });

    // An expired token fails verify(), so no principal can be recovered and
    // the request falls to the shared IP bucket.
    it('falls back to the ip bucket when verification fails (expired or forged)', async () => {
      verify.mockReturnValue(null);
      await expect(tracker(req(`Bearer ${capToken}`))).resolves.toBe(`${IP_BUCKET_PREFIX}10.0.0.1`);
    });

    it('falls back to the ip bucket when claims carry no uid', async () => {
      verify.mockReturnValue({ uid: '', rid: 'r', exp: Date.now() + 1000, scopes: [] });
      await expect(tracker(req(`Bearer ${capToken}`))).resolves.toBe(`${IP_BUCKET_PREFIX}10.0.0.1`);
    });

    it('does not try to verify a capability token as a JWT', async () => {
      verify.mockReturnValue(null);
      await tracker(req(`Bearer ${capToken}`));
      expect(verify).toHaveBeenCalledTimes(1);
    });
  });

  it('a userId that looks like an IP cannot collide with an IP bucket', async () => {
    const asUser = await tracker(req(`Bearer ${await sign({ sub: '10.0.0.1' })}`));
    const asIp = await tracker(req(undefined, '10.0.0.1'));
    expect(asUser).not.toBe(asIp);
  });
});
