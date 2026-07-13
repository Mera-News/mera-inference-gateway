import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import { JWT_ISSUER } from '../constants';
import {
  CAPABILITY_TOKEN_PREFIX,
  CapabilityClaims,
  CapabilityTokenService,
} from './capability-token.service';

export interface AuthenticatedUser {
  id: string;
  subscriptionIsActive: boolean;
  /** Set when this request authed with a capability token instead of a JWT.
   *  Downstream handlers use it to enforce `rid` / scope restrictions. */
  capability?: CapabilityClaims;
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}

interface MeraJwtPayload extends JWTPayload {
  userId?: string;
  subscriptionIsActive?: boolean;
}

@Injectable()
export class AuthGuard implements CanActivate, OnModuleInit {
  private readonly logger = new Logger('AuthGuard');
  private jwks!: JWTVerifyGetKey;
  private jwtIssuer!: string;

  constructor(
    private configService: ConfigService,
    private capabilityTokens: CapabilityTokenService,
  ) {}

  onModuleInit() {
    const authJwksUrl = this.configService.get<string>('AUTH_JWKS_URL', '');
    if (!authJwksUrl) {
      throw new Error('AUTH_JWKS_URL environment variable is not set');
    }

    // Forks running their own auth service override the expected issuer via
    // AUTH_JWT_ISSUER; defaults to the Mera auth service's issuer claim.
    this.jwtIssuer = this.configService.get<string>('AUTH_JWT_ISSUER', JWT_ISSUER);

    const jwksUrl = new URL(authJwksUrl);
    this.jwks = createRemoteJWKSet(jwksUrl);

    void this.verifyJwksReachability(jwksUrl, authJwksUrl);
  }

  private async verifyJwksReachability(jwksUrl: URL, authJwksUrl: string): Promise<void> {
    const maxElapsedMs = 10 * 60 * 1000;
    const start = Date.now();
    let delayMs = 1000;

    while (true) {
      try {
        const res = await fetch(jwksUrl);
        if (!res.ok) throw new Error(`JWKS endpoint returned ${res.status}`);
        this.logger.log(`JWKS endpoint verified: ${authJwksUrl}`);
        return;
      } catch (error) {
        const elapsed = Date.now() - start;
        if (elapsed + delayMs > maxElapsedMs) {
          this.logger.error(
            `JWKS endpoint ${authJwksUrl} unreachable after ${Math.round(elapsed / 1000)}s — giving up background verification: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        this.logger.warn(`JWKS endpoint unreachable, retrying in ${delayMs / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 30000);
      }
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const token = this.extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException('Authentication required');
    }

    // Capability-token path. Lets background callers (silent-push wakes,
    // result fetch loops) authenticate without ever reading the keychain
    // session JWT. Tokens are minted by InferenceJobsService on submit and
    // carried by the client for the lifetime of the cycle.
    if (token.startsWith(CAPABILITY_TOKEN_PREFIX)) {
      const claims = this.capabilityTokens.verify(token);
      if (!claims) {
        throw new UnauthorizedException('Invalid or expired capability token');
      }
      request.user = {
        id: claims.uid,
        // Capability tokens are minted post-subscription-check at submit time;
        // we trust the original gate held when the cycle started. The window
        // is bounded by the token's 2h TTL.
        subscriptionIsActive: true,
        capability: claims,
      };
      return true;
    }

    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.jwtIssuer,
      });

      const jwtPayload = payload as MeraJwtPayload;

      // A token with no subject cannot identify a principal. Falling back to an
      // empty-string id would let an unidentifiable caller act as the owner of
      // any doc whose userId is '' — reject instead.
      const id = jwtPayload.sub ?? jwtPayload.userId;
      if (!id) {
        throw new UnauthorizedException('Token is missing a subject claim');
      }

      request.user = {
        id,
        subscriptionIsActive: jwtPayload.subscriptionIsActive === true,
      };

      return true;
    } catch (error: unknown) {
      // Re-throw our own auth rejections verbatim (don't relabel as "failed").
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      if (
        error instanceof joseErrors.JWTExpired ||
        error instanceof joseErrors.JWSSignatureVerificationFailed ||
        error instanceof joseErrors.JWTClaimValidationFailed
      ) {
        throw new UnauthorizedException('Invalid or expired token');
      }
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Unexpected authentication error',
      );
      throw new UnauthorizedException('Authentication failed');
    }
  }

  private extractBearerToken(request: Request): string | null {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return null;
    }
    return authHeader.slice(7);
  }
}
