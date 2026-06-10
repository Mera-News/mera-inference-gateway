/**
 * app.module.spec.ts
 *
 * Uses the CAPTURE-THE-FACTORY pattern for:
 *   • LoggerModule.forRootAsync  (nestjs-pino)
 *   • ThrottlerModule.forRootAsync (@nestjs/throttler)
 *
 * All heavy submodules (DatabaseModule, QueuesModule, and every feature
 * module) are stubbed so the test never touches Mongo, Redis, or Expo SDKs.
 */

// ---------------------------------------------------------------------------
// 1. expo-server-sdk stub (reachable transitively through QueuesModule stub
//    but we stub it up-front as insurance)
// ---------------------------------------------------------------------------
jest.mock('expo-server-sdk', () => {
  class Expo {
    static isExpoPushToken = () => false;
    chunkPushNotifications = () => [];
    sendPushNotificationsAsync = async () => [];
    constructor(_o?: unknown) {}
  }
  return { Expo };
});

// ---------------------------------------------------------------------------
// 2. Capture holder
// ---------------------------------------------------------------------------
const mockCapture: Record<string, any> = {};

// ---------------------------------------------------------------------------
// 3. nestjs-pino mock
// ---------------------------------------------------------------------------
jest.mock('nestjs-pino', () => ({
  LoggerModule: {
    forRootAsync: (opts: any) => {
      mockCapture.loggerFactory = opts.useFactory;
      return { module: class LoggerModuleStub {} };
    },
  },
  Logger: class LoggerStub {},
  InjectPinoLogger: () => () => {},
}));

// ---------------------------------------------------------------------------
// 4. @nestjs/throttler mock
// ---------------------------------------------------------------------------
jest.mock('@nestjs/throttler', () => ({
  ThrottlerModule: {
    forRootAsync: (opts: any) => {
      mockCapture.throttlerFactory = opts.useFactory;
      return { module: class ThrottlerModuleStub {} };
    },
  },
  ThrottlerGuard: class ThrottlerGuardStub {},
}));

// ---------------------------------------------------------------------------
// 5. @bull-board/nestjs mock
// ---------------------------------------------------------------------------
jest.mock('@bull-board/nestjs', () => ({
  BullBoardModule: {
    forRoot: (_opts: any) => ({ module: class BullBoardRootStub {} }),
    forFeature: (..._args: any[]) => ({ module: class BullBoardFeatureStub {} }),
  },
}));

// ---------------------------------------------------------------------------
// 6. @bull-board/express mock
// ---------------------------------------------------------------------------
jest.mock('@bull-board/express', () => ({
  ExpressAdapter: class ExpressAdapterStub {},
}));

// ---------------------------------------------------------------------------
// 7. @nestjs/core mock (provides APP_GUARD token)
// ---------------------------------------------------------------------------
jest.mock('@nestjs/core', () => ({
  APP_GUARD: 'APP_GUARD',
  Reflector: class ReflectorStub {},
}));

// ---------------------------------------------------------------------------
// 8. @nestjs/config – keep real ConfigModule behaviour but stub forRoot so
//    it doesn't try to read .env files and returns a lightweight module.
// ---------------------------------------------------------------------------
jest.mock('@nestjs/config', () => ({
  ConfigModule: {
    forRoot: (_opts?: any) => ({ module: class ConfigModuleStub {} }),
  },
  ConfigService: class ConfigServiceStub {},
}));

// ---------------------------------------------------------------------------
// 9. Stub all heavy submodules
// ---------------------------------------------------------------------------
jest.mock('./database/database.module', () => ({
  DatabaseModule: class DatabaseModuleStub {},
}));
jest.mock('./queues/queues.module', () => ({
  QueuesModule: class QueuesModuleStub {},
}));
jest.mock('./auth/auth.module', () => ({
  AuthModule: class AuthModuleStub {},
}));
jest.mock('./chat/chat.module', () => ({
  ChatModule: class ChatModuleStub {},
}));
jest.mock('./attestation/attestation.module', () => ({
  AttestationModule: class AttestationModuleStub {},
}));
jest.mock('./notifications/notifications.module', () => ({
  NotificationsModule: class NotificationsModuleStub {},
}));
jest.mock('./inference-jobs/inference-jobs.module', () => ({
  InferenceJobsModule: class InferenceJobsModuleStub {},
}));
jest.mock('./health/health.controller', () => ({
  HealthController: class HealthControllerStub {},
}));

// ---------------------------------------------------------------------------
// Import the real AppModule AFTER all mocks are in place.
// ---------------------------------------------------------------------------
import { AppModule } from './app.module';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cfg = (vals: Record<string, unknown>) => ({
  get: (k: string, fb?: unknown) => (k in vals ? vals[k] : fb),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AppModule', () => {
  it('AppModule is defined', () => {
    expect(AppModule).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// LoggerModule useFactory tests
// ---------------------------------------------------------------------------

describe('AppModule – LoggerModule useFactory', () => {
  it('factory was captured (sanity)', () => {
    expect(typeof mockCapture.loggerFactory).toBe('function');
  });

  describe('NODE_ENV=production', () => {
    let result: any;

    beforeAll(() => {
      result = mockCapture.loggerFactory(cfg({ NODE_ENV: 'production' }));
    });

    it('transport is undefined in production', () => {
      expect(result.pinoHttp.transport).toBeUndefined();
    });

    it('level defaults to warn in production', () => {
      expect(result.pinoHttp.level).toBe('warn');
    });

    it('autoLogging.ignore("/health") returns true', () => {
      expect(result.pinoHttp.autoLogging.ignore({ url: '/health' })).toBe(true);
    });

    it('autoLogging.ignore("/other") returns false', () => {
      expect(result.pinoHttp.autoLogging.ignore({ url: '/x' })).toBe(false);
    });
  });

  describe('NODE_ENV=development', () => {
    let result: any;

    beforeAll(() => {
      result = mockCapture.loggerFactory(cfg({ NODE_ENV: 'development' }));
    });

    it('transport.target is pino-pretty', () => {
      expect(result.pinoHttp.transport.target).toBe('pino-pretty');
    });

    it('level defaults to debug in development', () => {
      expect(result.pinoHttp.level).toBe('debug');
    });

    it('autoLogging is false in development', () => {
      expect(result.pinoHttp.autoLogging).toBe(false);
    });
  });

  describe('LOG_LEVEL override', () => {
    it('respects explicit LOG_LEVEL over the NODE_ENV default', () => {
      const result = mockCapture.loggerFactory(cfg({ NODE_ENV: 'production', LOG_LEVEL: 'error' }));
      expect(result.pinoHttp.level).toBe('error');
    });
  });

  describe('formatters', () => {
    let formatters: any;

    beforeAll(() => {
      const result = mockCapture.loggerFactory(cfg({ NODE_ENV: 'production' }));
      formatters = result.pinoHttp.formatters;
    });

    it('level formatter maps numeric 30 (INFO) to severity INFO', () => {
      expect(formatters.level('info', 30)).toEqual({ severity: 'INFO', level: 'info' });
    });

    it('level formatter maps numeric 40 (WARN) to severity WARNING', () => {
      expect(formatters.level('warn', 40)).toEqual({ severity: 'WARNING', level: 'warn' });
    });

    it('level formatter maps numeric 50 (ERROR) to severity ERROR', () => {
      expect(formatters.level('error', 50)).toEqual({ severity: 'ERROR', level: 'error' });
    });

    it('level formatter maps unknown level number to severity DEFAULT', () => {
      expect(formatters.level('custom', 99)).toEqual({ severity: 'DEFAULT', level: 'custom' });
    });

    it('log formatter moves msg to message and keeps the rest', () => {
      expect(formatters.log({ msg: 'm', a: 1 })).toEqual({ a: 1, message: 'm' });
    });

    it('log formatter returns message: undefined when msg is absent', () => {
      const r = formatters.log({ a: 1 });
      expect(r).toEqual({ a: 1, message: undefined });
    });
  });

  describe('serializers', () => {
    let serializers: any;

    beforeAll(() => {
      const result = mockCapture.loggerFactory(cfg({ NODE_ENV: 'production' }));
      serializers = result.pinoHttp.serializers;
    });

    it('req serializer returns method and url', () => {
      expect(serializers.req({ method: 'GET', url: '/x' })).toEqual({
        method: 'GET',
        url: '/x',
      });
    });

    it('res serializer returns statusCode', () => {
      expect(serializers.res({ statusCode: 200 })).toEqual({ statusCode: 200 });
    });

    it('err serializer returns type, message, and stack', () => {
      const err = new Error('e');
      const r = serializers.err(err);
      expect(r.type).toBe('Error');
      expect(r.message).toBe('e');
      expect(typeof r.stack).toBe('string');
    });
  });
});

// ---------------------------------------------------------------------------
// ThrottlerModule useFactory tests
// ---------------------------------------------------------------------------

describe('AppModule – ThrottlerModule useFactory', () => {
  it('factory was captured (sanity)', () => {
    expect(typeof mockCapture.throttlerFactory).toBe('function');
  });

  it('returns default ttl=60000ms and limit=30 when no env vars set', () => {
    const result = mockCapture.throttlerFactory(cfg({}));
    expect(result).toEqual([{ ttl: 60_000, limit: 30 }]);
  });

  it('multiplies THROTTLE_TTL by 1000 to convert seconds to ms', () => {
    const result = mockCapture.throttlerFactory(cfg({ THROTTLE_TTL: 5, THROTTLE_LIMIT: 100 }));
    expect(result).toEqual([{ ttl: 5_000, limit: 100 }]);
  });

  it('returns a single-element array (as ThrottlerModule expects)', () => {
    const result = mockCapture.throttlerFactory(cfg({}));
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
  });
});
