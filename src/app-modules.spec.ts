/**
 * app-modules.spec.ts
 *
 * Verifies that each feature module class can be imported without throwing.
 * We do NOT instantiate or boot any Nest application — merely importing the
 * class evaluates its decorator metadata, which is sufficient for line-
 * coverage on the module decorator declarations.
 *
 * Import-time side-effects that would throw (BullMQ forRootAsync, Mongoose
 * forFeature, BullBoard forFeature) are neutralised by the mocks below.
 */

// ── Expo ────────────────────────────────────────────────────────────────────
// expo-server-sdk is pulled in transitively through NotificationsModule →
// ExpoPushService.  Mock it before any module import happens.
jest.mock('expo-server-sdk', () => {
  const isExpoPushToken = () => false;
  class Expo {
    static isExpoPushToken = isExpoPushToken;
    chunkPushNotifications = () => [];
    sendPushNotificationsAsync = async () => [];
    constructor(_o?: unknown) {}
  }
  return { Expo };
});

// ── BullMQ / Mongoose / BullBoard ────────────────────────────────────────────
// These NestJS dynamic-module helpers would ordinarily require live config
// (Redis URL, Mongo URI) at module-init time.  Since we are only importing
// the *class* and never booting Nest, the decorator arguments (forRootAsync /
// forFeature) are evaluated immediately at import time — and may throw if the
// underlying library performs eager validation.  We replace the entire module
// with thin stubs that return a plain NestJS-compatible module descriptor.

const stubDynamicModule = () => ({ module: class {} });

jest.mock('@nestjs/bullmq', () => ({
  BullModule: {
    forRoot: stubDynamicModule,
    forRootAsync: stubDynamicModule,
    registerQueue: stubDynamicModule,
    registerFlowProducer: stubDynamicModule,
  },
  InjectQueue: () => () => {},
  InjectFlowProducer: () => () => {},
  Processor: () => () => {},
  WorkerHost: class {},
  getQueueToken: (name: string) => `BULL_QUEUE_${name}`,
  getFlowProducerToken: (name: string) => `BULL_FLOW_${name}`,
}));

jest.mock('@nestjs/mongoose', () => ({
  MongooseModule: {
    forRoot: stubDynamicModule,
    forRootAsync: stubDynamicModule,
    forFeature: stubDynamicModule,
  },
  InjectModel: () => () => {},
  Prop: () => () => {},
  Schema: () => () => {},
  SchemaFactory: {
    createForClass: () => ({
      index: () => {},
      virtual: () => ({ get: () => {} }),
    }),
  },
  getModelToken: (name: string) => `${name}Model`,
}));

jest.mock('@bull-board/nestjs', () => ({
  BullBoardModule: {
    forRoot: stubDynamicModule,
    forRootAsync: stubDynamicModule,
    forFeature: stubDynamicModule,
  },
}));

// ── jose ─────────────────────────────────────────────────────────────────────
// jose is an ESM-only package; the jest config already has a transformIgnorePatterns
// carve-out for it, but mock it anyway to avoid network calls in AuthGuard.onModuleInit.
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(),
  SignJWT: jest.fn().mockImplementation(() => ({
    setProtectedHeader: jest.fn().mockReturnThis(),
    setIssuer: jest.fn().mockReturnThis(),
    setSubject: jest.fn().mockReturnThis(),
    setExpirationTime: jest.fn().mockReturnThis(),
    setIssuedAt: jest.fn().mockReturnThis(),
    sign: jest.fn().mockResolvedValue('mock.jwt.token'),
  })),
  jwtDecrypt: jest.fn(),
  errors: {
    JWTExpired: class JWTExpired extends Error {},
    JWSSignatureVerificationFailed: class JWSSignatureVerificationFailed extends Error {},
    JWTClaimValidationFailed: class JWTClaimValidationFailed extends Error {},
  },
}));

// ── Lazy imports (after all mocks are registered) ───────────────────────────

/* eslint-disable @typescript-eslint/no-var-requires */
describe('Feature modules are defined', () => {
  it('AuthModule is defined', () => {
    const { AuthModule } = require('./auth/auth.module');
    expect(AuthModule).toBeDefined();
  });

  it('ChatModule is defined', () => {
    const { ChatModule } = require('./chat/chat.module');
    expect(ChatModule).toBeDefined();
  });

  it('AttestationModule is defined', () => {
    const { AttestationModule } = require('./attestation/attestation.module');
    expect(AttestationModule).toBeDefined();
  });

  it('NotificationsModule is defined', () => {
    const { NotificationsModule } = require('./notifications/notifications.module');
    expect(NotificationsModule).toBeDefined();
  });

  it('InferenceJobsModule is defined', () => {
    const { InferenceJobsModule } = require('./inference-jobs/inference-jobs.module');
    expect(InferenceJobsModule).toBeDefined();
  });
});
