// Must mock expo-server-sdk before any import that reaches ExpoPushService.
jest.mock('expo-server-sdk', () => {
  const isExpoPushToken = jest.fn(
    (t: string) => typeof t === 'string' && t.startsWith('ExponentPushToken['),
  );
  class Expo {
    static isExpoPushToken = isExpoPushToken;
    chunkPushNotifications = jest.fn((msgs: unknown[]) => [msgs]);
    sendPushNotificationsAsync = jest.fn().mockResolvedValue([{ status: 'ok' }]);
    constructor(_opts?: unknown) {}
  }
  return { Expo };
});

import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import type { Job } from 'bullmq';
import { NotifyUserProcessor } from './notify-user.processor';
import type { ExpoPushService } from '../notifications/expo-push.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(info: { expoPushToken: string | null } | null) {
  return { getNotifyInfo: jest.fn().mockResolvedValue(info) };
}

function makeJob(jobId: string): Job<{ jobId: string }> {
  return { data: { jobId } } as unknown as Job<{ jobId: string }>;
}

function makePush(): jest.Mocked<Pick<ExpoPushService, 'sendSilent'>> {
  return { sendSilent: jest.fn().mockResolvedValue(undefined) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NotifyUserProcessor', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    // 'warn'/'error' are silenced for clean output; only 'log' is asserted on.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects with an error matching /not found at notify-user/ when the job is unknown', async () => {
    const jobId = new Types.ObjectId().toString();
    const store = makeStore(null);
    const push = makePush();
    const processor = new NotifyUserProcessor(store as never, push as never);

    await expect(processor.process(makeJob(jobId))).rejects.toThrow(/not found at notify-user/);
  });

  it('logs skip, returns { ok: true }, and does NOT call push.sendSilent when expoPushToken is null', async () => {
    const jobId = new Types.ObjectId().toString();
    const store = makeStore({ expoPushToken: null });
    const push = makePush();
    const processor = new NotifyUserProcessor(store as never, push as never);

    const result = await processor.process(makeJob(jobId));

    expect(result).toEqual({ ok: true });
    expect(push.sendSilent).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
  });

  it('calls push.sendSilent with the correct args and returns { ok: true } for a valid token', async () => {
    const jobId = new Types.ObjectId().toString();
    const store = makeStore({ expoPushToken: 'ExponentPushToken[x]' });
    const push = makePush();
    const processor = new NotifyUserProcessor(store as never, push as never);

    const result = await processor.process(makeJob(jobId));

    expect(result).toEqual({ ok: true });
    expect(push.sendSilent).toHaveBeenCalledTimes(1);
    expect(push.sendSilent).toHaveBeenCalledWith({
      to: 'ExponentPushToken[x]',
      data: { type: 'inference-done', requestId: jobId },
    });
  });

  it('calls store.getNotifyInfo with the jobId', async () => {
    const jobId = new Types.ObjectId().toString();
    const store = makeStore({ expoPushToken: 'ExponentPushToken[x]' });
    const push = makePush();
    const processor = new NotifyUserProcessor(store as never, push as never);

    await processor.process(makeJob(jobId));

    expect(store.getNotifyInfo).toHaveBeenCalledTimes(1);
    expect(store.getNotifyInfo).toHaveBeenCalledWith(jobId);
  });
});
