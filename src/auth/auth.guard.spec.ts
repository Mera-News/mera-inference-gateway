import { ExecutionContext, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { JWT_ISSUER } from '../constants';
import { AuthGuard } from './auth.guard';
import {
  CAPABILITY_TOKEN_PREFIX,
  CapabilityClaims,
  CapabilityTokenService,
} from './capability-token.service';

// --- jose mock --------------------------------------------------------------
// createRemoteJWKSet returns a sentinel; jwtVerify is a controllable jest.fn.
// We preserve the real `errors` classes so the guard's instanceof checks work.
const mockJwtVerify = jest.fn();
jest.mock('jose', () => {
  const actual = jest.requireActual('jose');
  return {
    ...actual,
    createRemoteJWKSet: jest.fn(() => 'jwks-sentinel'),
    jwtVerify: (...args: unknown[]) => mockJwtVerify(...args),
  };
});

function makeContext(authHeader?: string): ExecutionContext {
  const request: { headers: Record<string, unknown>; user?: unknown } = {
    headers: authHeader ? { authorization: authHeader } : {},
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

function getRequest(ctx: ExecutionContext): { user?: unknown } {
  return ctx.switchToHttp().getRequest();
}

describe('AuthGuard', () => {
  let guard: AuthGuard;
  let capabilityTokens: { verify: jest.Mock };
  let configValues: Record<string, string>;

  beforeEach(async () => {
    mockJwtVerify.mockReset();
    configValues = {
      AUTH_JWKS_URL: 'https://auth.example.com/jwks',
    };
    capabilityTokens = { verify: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthGuard,
        {
          provide: ConfigService,
          useValue: {
            get: <T>(key: string, fallback?: T): T =>
              (configValues[key] as unknown as T) ?? (fallback as T),
          },
        },
        { provide: CapabilityTokenService, useValue: capabilityTokens },
      ],
    }).compile();

    guard = module.get(AuthGuard);
    // onModuleInit sets up the jwks + issuer. We don't await the background
    // reachability probe (fire-and-forget inside the guard).
    guard.onModuleInit();
  });

  it('throws if AUTH_JWKS_URL is not set', async () => {
    delete configValues.AUTH_JWKS_URL;
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthGuard,
        {
          provide: ConfigService,
          useValue: { get: <T>(_k: string, fb?: T): T => fb as T },
        },
        { provide: CapabilityTokenService, useValue: capabilityTokens },
      ],
    }).compile();
    const g = module.get(AuthGuard);
    expect(() => g.onModuleInit()).toThrow(/AUTH_JWKS_URL/);
  });

  describe('bearer extraction', () => {
    it('rejects when Authorization header is missing', async () => {
      await expect(guard.canActivate(makeContext())).rejects.toThrow(UnauthorizedException);
    });

    it('rejects when header does not start with Bearer', async () => {
      await expect(guard.canActivate(makeContext('Token abc'))).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('JWT path', () => {
    it('allows a valid JWT and attaches the user', async () => {
      mockJwtVerify.mockResolvedValue({
        payload: {
          sub: 'user-42',
          iss: JWT_ISSUER,
          subscriptionIsActive: true,
        },
      });
      const ctx = makeContext('Bearer good.jwt.token');
      await expect(guard.canActivate(ctx)).resolves.toBe(true);

      expect(mockJwtVerify).toHaveBeenCalledWith('good.jwt.token', 'jwks-sentinel', {
        issuer: JWT_ISSUER,
      });
      expect(getRequest(ctx).user).toEqual({
        id: 'user-42',
        subscriptionIsActive: true,
      });
    });

    it('falls back to userId claim and defaults subscription to false', async () => {
      mockJwtVerify.mockResolvedValue({
        payload: { userId: 'user-99', iss: JWT_ISSUER },
      });
      const ctx = makeContext('Bearer good.jwt.token');
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(getRequest(ctx).user).toEqual({
        id: 'user-99',
        subscriptionIsActive: false,
      });
    });

    it('rejects a validly-signed JWT that carries neither sub nor userId', async () => {
      // A token with no subject cannot identify a principal. Authenticating it
      // as the empty-string user would let an unidentifiable caller act as the
      // owner of any doc whose userId is '' — reject instead.
      mockJwtVerify.mockResolvedValue({
        payload: { iss: JWT_ISSUER, subscriptionIsActive: true },
      });
      await expect(guard.canActivate(makeContext('Bearer no.subject.token'))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('honors AUTH_JWT_ISSUER override', async () => {
      configValues.AUTH_JWT_ISSUER = 'fork-issuer';
      guard.onModuleInit();
      mockJwtVerify.mockResolvedValue({
        payload: { sub: 'user-1', iss: 'fork-issuer' },
      });
      await guard.canActivate(makeContext('Bearer t'));
      expect(mockJwtVerify).toHaveBeenCalledWith('t', 'jwks-sentinel', {
        issuer: 'fork-issuer',
      });
    });

    it('maps a wrong-issuer claim failure to UnauthorizedException', async () => {
      const { errors } = jest.requireActual('jose');
      mockJwtVerify.mockRejectedValue(
        new errors.JWTClaimValidationFailed('unexpected "iss" claim value'),
      );
      await expect(guard.canActivate(makeContext('Bearer wrong.issuer'))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('maps an expired JWT to UnauthorizedException', async () => {
      const { errors } = jest.requireActual('jose');
      mockJwtVerify.mockRejectedValue(new errors.JWTExpired('expired', {}));
      await expect(guard.canActivate(makeContext('Bearer expired'))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('maps an unexpected error to UnauthorizedException', async () => {
      mockJwtVerify.mockRejectedValue(new Error('network blip'));
      await expect(guard.canActivate(makeContext('Bearer t'))).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('JWKS reachability', () => {
    let originalFetch: typeof global.fetch;
    let mockFetch: jest.Mock;
    let logSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
      originalFetch = global.fetch;
      mockFetch = jest.fn();
      global.fetch = mockFetch;
      logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      jest.useFakeTimers();
    });

    afterEach(() => {
      global.fetch = originalFetch;
      jest.restoreAllMocks();
      jest.useRealTimers();
    });

    it('logs "verified" and resolves immediately when first fetch succeeds', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      await guard['verifyJwksReachability'](
        new URL('https://issuer.test/jwks.json'),
        'https://issuer.test/jwks.json',
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const logCall = logSpy.mock.calls[0][0] as string;
      expect(logCall).toMatch(/verified/i);
    });

    it('retries once after a failed fetch and resolves with "verified" on second try', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({ ok: true, status: 200 });

      const promise = guard['verifyJwksReachability'](
        new URL('https://issuer.test/jwks.json'),
        'https://issuer.test/jwks.json',
      );

      // Let the first fetch settle and enter the catch block.
      await Promise.resolve();
      await Promise.resolve();

      // Advance past the 1000ms backoff timer so the second fetch runs.
      await jest.advanceTimersByTimeAsync(1000);

      await promise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const logCall = logSpy.mock.calls[0][0] as string;
      expect(logCall).toMatch(/verified/i);
    });

    it('logs "giving up" and resolves when elapsed time exceeds the maximum', async () => {
      // Make fetch always reject.
      mockFetch.mockRejectedValue(new Error('connection refused'));

      // Spy on Date.now: first call returns the start time (0), subsequent
      // calls (inside the catch to compute elapsed) return a value past the
      // 10-minute maximum so the give-up branch is taken immediately after
      // the very first failure, keeping the test bounded.
      const maxElapsedMs = 10 * 60 * 1000;
      let callCount = 0;
      jest.spyOn(Date, 'now').mockImplementation(() => {
        // 0 on first call (start = 0), then beyond max on every later call.
        return callCount++ === 0 ? 0 : maxElapsedMs + 1;
      });

      await guard['verifyJwksReachability'](
        new URL('https://issuer.test/jwks.json'),
        'https://issuer.test/jwks.json',
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const errorCall = errorSpy.mock.calls[0][0] as string;
      expect(errorCall).toMatch(/giving up/i);
      // warn should NOT have been called because we went straight to give-up.
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('capability-token path', () => {
    const claims: CapabilityClaims = {
      uid: 'user-7',
      rid: 'req-7',
      exp: Date.now() + 100000,
      scopes: ['results:read', 'jobs:submit-followup'],
    };

    it('delegates to CapabilityTokenService and attaches the user', async () => {
      capabilityTokens.verify.mockReturnValue(claims);
      const ctx = makeContext(`Bearer ${CAPABILITY_TOKEN_PREFIX}payload.sig`);
      await expect(guard.canActivate(ctx)).resolves.toBe(true);

      expect(capabilityTokens.verify).toHaveBeenCalledWith(`${CAPABILITY_TOKEN_PREFIX}payload.sig`);
      expect(getRequest(ctx).user).toEqual({
        id: 'user-7',
        subscriptionIsActive: true,
        capability: claims,
      });
      // JWKS verification must NOT run for capability tokens.
      expect(mockJwtVerify).not.toHaveBeenCalled();
    });

    it('rejects an invalid capability token', async () => {
      capabilityTokens.verify.mockReturnValue(null);
      await expect(
        guard.canActivate(makeContext(`Bearer ${CAPABILITY_TOKEN_PREFIX}bad`)),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
