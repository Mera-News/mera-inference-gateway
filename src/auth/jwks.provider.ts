import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';

/** Owns the remote key set so the auth guard and the throttle tracker share one
 *  cache and one fetch. */
@Injectable()
export class JwksProvider {
  readonly url: URL;
  readonly keys: JWTVerifyGetKey;

  constructor(configService: ConfigService) {
    const authJwksUrl = configService.get<string>('AUTH_JWKS_URL', '');
    if (!authJwksUrl) {
      throw new Error('AUTH_JWKS_URL environment variable is not set');
    }
    this.url = new URL(authJwksUrl);
    this.keys = createRemoteJWKSet(this.url);
  }
}
