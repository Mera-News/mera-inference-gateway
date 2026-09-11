import { ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
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

  // Asserts the decorator rather than the response. Hitting /health repeatedly
  // and asserting 200 proves nothing here: the storage fails open, so that
  // check passes identically with @SkipThrottle removed and Redis down. The
  // behavioural half of this lives in test/throttle.e2e-spec.ts, which runs a
  // LOW limit against a LIVE Redis so it can actually fail.
  it('is marked @SkipThrottle so probes never consume a rate-limit budget', () => {
    // THROTTLER_SKIP + 'default' -- the key ThrottlerGuard reads. The constant
    // is not exported from the package index, so it is spelled out here.
    const skip = new Reflector().getAllAndOverride<boolean>('THROTTLER:SKIPdefault', [
      HealthController.prototype.check,
      HealthController,
    ]);
    expect(skip).toBe(true);
  });
});
