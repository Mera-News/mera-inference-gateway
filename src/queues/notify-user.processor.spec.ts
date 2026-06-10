// Must mock expo-server-sdk before any import that reaches ExpoPushService.
jest.mock('expo-server-sdk', () => {
  const isExpoPushToken = jest.fn((t: string) => typeof t === 'string' && t.startsWith('ExponentPushToken['));
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

function makeModel(doc: unknown) {
  return {
    findById: jest.fn().mockReturnValue({
      lean: () => ({ exec: jest.fn().mockResolvedValue(doc) }),
    }),
  };
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
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects with an error matching /not found at notify-user/ when the doc is not found', async () => {
    const jobId = new Types.ObjectId().toString();
    const model = makeModel(null);
    const push = makePush();
    const processor = new NotifyUserProcessor(model as never, push as never);

    await expect(processor.process(makeJob(jobId))).rejects.toThrow(/not found at notify-user/);
  });

  it('logs skip, returns { ok: true }, and does NOT call push.sendSilent when expoPushToken is null', async () => {
    const jobId = new Types.ObjectId().toString();
    const doc = { expoPushToken: null };
    const model = makeModel(doc);
    const push = makePush();
    const processor = new NotifyUserProcessor(model as never, push as never);

    const result = await processor.process(makeJob(jobId));

    expect(result).toEqual({ ok: true });
    expect(push.sendSilent).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
  });

  it('calls push.sendSilent with the correct args and returns { ok: true } for a valid token', async () => {
    const jobId = new Types.ObjectId().toString();
    const doc = { expoPushToken: 'ExponentPushToken[x]' };
    const model = makeModel(doc);
    const push = makePush();
    const processor = new NotifyUserProcessor(model as never, push as never);

    const result = await processor.process(makeJob(jobId));

    expect(result).toEqual({ ok: true });
    expect(push.sendSilent).toHaveBeenCalledTimes(1);
    expect(push.sendSilent).toHaveBeenCalledWith({
      to: 'ExponentPushToken[x]',
      data: { type: 'inference-done', requestId: jobId },
    });
  });

  it('calls findById with an ObjectId and the { expoPushToken: 1 } projection', async () => {
    const jobId = new Types.ObjectId().toString();
    const doc = { expoPushToken: 'ExponentPushToken[x]' };
    const model = makeModel(doc);
    const push = makePush();
    const processor = new NotifyUserProcessor(model as never, push as never);

    await processor.process(makeJob(jobId));

    expect(model.findById).toHaveBeenCalledTimes(1);
    const [idArg, projectionArg] = model.findById.mock.calls[0] as [Types.ObjectId, unknown];

    // The argument should be an ObjectId instance.
    expect(idArg).toBeInstanceOf(Types.ObjectId);
    // And it should represent the same jobId that was passed in.
    expect(idArg.toString()).toBe(jobId);

    expect(projectionArg).toEqual({ expoPushToken: 1 });
  });
});
