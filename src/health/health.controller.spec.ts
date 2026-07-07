import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('check() returns { status: "ok" } when the job store pings', async () => {
    const store = { ping: jest.fn().mockResolvedValue(undefined) };
    const controller = new HealthController(store as never);
    await expect(controller.check()).resolves.toEqual({ status: 'ok' });
  });

  it('check() throws 503 when the job store is unreachable', async () => {
    const store = { ping: jest.fn().mockRejectedValue(new Error('down')) };
    const controller = new HealthController(store as never);
    await expect(controller.check()).rejects.toThrow(ServiceUnavailableException);
  });
});
