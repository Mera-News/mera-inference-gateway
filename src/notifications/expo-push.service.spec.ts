// Shared mock fns (jest-hoist-safe: names prefixed with `mock`). The mocked
// Expo class wires its methods to these so tests can assert on them directly.
const mockChunkPushNotifications = jest.fn((msgs: unknown[]) => [msgs]);
const mockSendPushNotificationsAsync = jest.fn().mockResolvedValue([{ status: 'ok' }]);
const mockIsExpoPushToken = jest.fn(
  (t: string) => typeof t === 'string' && t.startsWith('ExponentPushToken['),
);
const mockExpoCtor = jest.fn();

jest.mock('expo-server-sdk', () => {
  class Expo {
    static isExpoPushToken = mockIsExpoPushToken;
    chunkPushNotifications = mockChunkPushNotifications;
    sendPushNotificationsAsync = mockSendPushNotificationsAsync;
    constructor(opts?: unknown) {
      mockExpoCtor(opts);
    }
  }
  return { Expo };
});

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExpoPushService } from './expo-push.service';

function makeConfig(values: Record<string, unknown>): ConfigService {
  return {
    get: <T>(key: string, fallback?: T): T => (values[key] as T) ?? (fallback as T),
  } as unknown as ConfigService;
}

describe('ExpoPushService', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    // Clear call counts first so the spies we set up below start clean.
    jest.clearAllMocks();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('constructor', () => {
    it('passes { accessToken: undefined } to Expo when EXPO_ACCESS_TOKEN is empty', () => {
      new ExpoPushService(makeConfig({ EXPO_ACCESS_TOKEN: '' }));
      expect(mockExpoCtor).toHaveBeenCalledWith({ accessToken: undefined });
    });

    it('passes { accessToken: <token> } to Expo when EXPO_ACCESS_TOKEN is set', () => {
      new ExpoPushService(makeConfig({ EXPO_ACCESS_TOKEN: 'my-access-token' }));
      expect(mockExpoCtor).toHaveBeenCalledWith({ accessToken: 'my-access-token' });
    });
  });

  describe('sendSilent', () => {
    it('logs a warning and returns early when the token is invalid', async () => {
      // isExpoPushToken returns false for non-ExponentPushToken strings
      mockIsExpoPushToken.mockReturnValueOnce(false);

      const svc = new ExpoPushService(makeConfig({}));

      await svc.sendSilent({ to: 'invalid-token', data: {} });

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid-token'));
      expect(mockChunkPushNotifications).not.toHaveBeenCalled();
    });

    it('builds correct message, chunks it, and calls sendPushNotificationsAsync for valid token', async () => {
      mockIsExpoPushToken.mockReturnValueOnce(true);

      const svc = new ExpoPushService(makeConfig({}));
      const data = { type: 'inference-done', requestId: 'abc123' };

      await svc.sendSilent({ to: 'ExponentPushToken[xxx]', data });

      expect(mockChunkPushNotifications).toHaveBeenCalledWith([
        {
          to: 'ExponentPushToken[xxx]',
          data,
          priority: 'high',
          _contentAvailable: true,
        },
      ]);
      expect(mockSendPushNotificationsAsync).toHaveBeenCalledTimes(1);
    });

    it('logs a warn containing the error message when a ticket has status error', async () => {
      mockIsExpoPushToken.mockReturnValueOnce(true);

      const svc = new ExpoPushService(makeConfig({}));

      mockSendPushNotificationsAsync.mockResolvedValueOnce([
        {
          status: 'error',
          message: 'DeviceNotRegistered',
          details: { error: 'DeviceNotRegistered' },
        },
      ]);

      await svc.sendSilent({ to: 'ExponentPushToken[xxx]', data: {} });

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('DeviceNotRegistered'));
    });

    it('catches a sendPushNotificationsAsync rejection, logs error, and resolves without throwing', async () => {
      mockIsExpoPushToken.mockReturnValueOnce(true);

      const svc = new ExpoPushService(makeConfig({}));

      mockSendPushNotificationsAsync.mockRejectedValueOnce(new Error('network failure'));

      // Must not throw — the service catches the error internally.
      await expect(
        svc.sendSilent({ to: 'ExponentPushToken[xxx]', data: {} }),
      ).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('network failure'));
    });
  });
});
