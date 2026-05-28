import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
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
