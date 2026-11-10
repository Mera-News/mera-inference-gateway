import { NotFoundException, UnauthorizedException, BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { RoutingController } from './routing.controller';
import type { RoutingService } from './routing.service';

function make(token: string) {
  const routing = {
    body: jest.fn().mockResolvedValue({ version: 3 }),
    setPin: jest.fn().mockResolvedValue(undefined),
  };
  const config = { get: (_k: string, fb?: unknown) => token || fb } as unknown as ConfigService;
  return {
    routing,
    controller: new RoutingController(routing as unknown as RoutingService, config),
  };
}

describe('RoutingController', () => {
  it('serves the table with no-store', async () => {
    const { controller } = make('');
    const res = { setHeader: jest.fn() };
    expect(await controller.get(res as never)).toEqual({ version: 3 });
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it('pin is a 404 when ROUTING_ADMIN_TOKEN is unset', async () => {
    const { controller, routing } = make('');
    await expect(
      controller.pin('anything', { profile: 'near/qwen3.8-27b', state: 'down' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(routing.setPin).not.toHaveBeenCalled();
  });

  it('pin rejects a wrong or missing token', async () => {
    const { controller, routing } = make('secret');
    const body = { profile: 'near/qwen3.8-27b', state: 'down' };
    await expect(controller.pin('nope', body)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.pin(undefined, body)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(routing.setPin).not.toHaveBeenCalled();
  });

  it('pin validates the profile and the state', async () => {
    const { controller } = make('secret');
    await expect(
      controller.pin('secret', { profile: 'x/y', state: 'down' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.pin('secret', { profile: 'near/qwen3.8-27b', state: 'maybe' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.pin('secret', undefined)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('pin applies and returns the new table', async () => {
    const { controller, routing } = make('secret');
    const out = await controller.pin('secret', { profile: 'near/qwen3.8-27b', state: 'auto' });
    expect(routing.setPin).toHaveBeenCalledWith('near/qwen3.8-27b', 'auto');
    expect(out).toEqual({ version: 3 });
  });
});
