import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import type { Response } from 'express';
import { PROFILES } from './profiles';
import { RoutingService } from './routing.service';

function sameToken(given: string | undefined, expected: string): boolean {
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

@Controller('v1/routing')
export class RoutingController {
  constructor(
    private readonly routing: RoutingService,
    private readonly config: ConfigService,
  ) {}

  /** No auth: the table holds no user data and the app reads it before sign-in. */
  @Get()
  async get(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.routing.body();
  }

  @Post('admin/pin')
  @HttpCode(200)
  async pin(@Headers('x-mera-admin-token') token: string | undefined, @Body() body: unknown) {
    const expected = this.config.get<string>('ROUTING_ADMIN_TOKEN', '');
    if (!expected) throw new NotFoundException();
    if (!sameToken(token, expected)) throw new UnauthorizedException();
    const { profile, state } = (body ?? {}) as { profile?: unknown; state?: unknown };
    if (typeof profile !== 'string' || !(profile in PROFILES)) {
      throw new BadRequestException('Unknown profile');
    }
    if (state !== 'up' && state !== 'down' && state !== 'auto') {
      throw new BadRequestException('state must be up, down or auto');
    }
    await this.routing.setPin(profile, state);
    return this.routing.body();
  }
}
