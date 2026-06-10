/**
 * queues.module.spec.ts
 *
 * Uses the CAPTURE-THE-FACTORY pattern for BullModule.forRootAsync.
 *
 * The queues module import graph reaches expo-server-sdk (via
 * NotificationsModule), the processor files that use @nestjs/bullmq
 * decorators, ChatModule, and the Mongoose schema helpers.  We stub all of
 * those at the module level so only QueuesModule's own factory logic runs
 * under test.
 */

// ---------------------------------------------------------------------------
// 1. expo-server-sdk stub (must come first – pulled in by NotificationsModule)
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
// 2. Capture holder – prefixed with "mock" so Jest hoisting allows it
// ---------------------------------------------------------------------------
const mockCapture: Record<string, any> = {};

// ---------------------------------------------------------------------------
// 3. @nestjs/bullmq mock
//    • forRootAsync  – captures the useFactory
//    • registerQueue / registerFlowProducer – harmless stubs
//    • Decorators and WorkerHost exported so processor files compile
// ---------------------------------------------------------------------------
jest.mock('@nestjs/bullmq', () => {
  class WorkerHost {
    async process(_job: unknown): Promise<unknown> {
      return null;
    }
  }
  return {
    BullModule: {
      forRootAsync: (opts: any) => {
        mockCapture.bullFactory = opts.useFactory;
        return { module: class BullRootStub {} };
      },
      registerQueue: (..._args: any[]) => ({ module: class BullQueueStub {} }),
      registerFlowProducer: (_opts: any) => ({ module: class BullFlowStub {} }),
    },
    InjectQueue: () => () => {},
    InjectFlowProducer: () => () => {},
    Processor: () => () => {},
    WorkerHost,
  };
});

// ---------------------------------------------------------------------------
// 4. @bull-board/nestjs stub
// ---------------------------------------------------------------------------
jest.mock('@bull-board/nestjs', () => ({
  BullBoardModule: {
    forRoot: (_opts: any) => ({ module: class BullBoardRootStub {} }),
    forFeature: (..._args: any[]) => ({ module: class BullBoardFeatureStub {} }),
  },
}));

// ---------------------------------------------------------------------------
// 5. @bull-board/api/bullMQAdapter stub
// ---------------------------------------------------------------------------
jest.mock('@bull-board/api/bullMQAdapter', () => ({
  BullMQAdapter: class BullMQAdapterStub {},
}));

// ---------------------------------------------------------------------------
// 6. @nestjs/mongoose stub (schema decorators + forFeature)
// ---------------------------------------------------------------------------
jest.mock('@nestjs/mongoose', () => ({
  MongooseModule: {
    forRootAsync: (opts: any) => {
      mockCapture.mongoFactory = opts.useFactory;
      return { module: class MongooseRootStub {} };
    },
    forFeature: () => ({ module: class MongooseFeatureStub {} }),
  },
  InjectModel: () => () => {},
  Prop: () => () => {},
  Schema: () => () => {},
  SchemaFactory: {
    createForClass: () => ({}),
  },
}));

// ---------------------------------------------------------------------------
// 7. Stub heavy submodules so we don't compile their entire trees
// ---------------------------------------------------------------------------
jest.mock('../chat/chat.module', () => ({ ChatModule: class ChatModuleStub {} }));
jest.mock('../notifications/notifications.module', () => ({
  NotificationsModule: class NotificationsModuleStub {},
}));

// ---------------------------------------------------------------------------
// 8. Stub processor files and FlowService to plain classes.
//    This avoids issues with decorator resolution at import time.
// ---------------------------------------------------------------------------
jest.mock('./llm-inference.processor', () => ({
  LlmInferenceProcessor: class LlmInferenceProcessorStub {},
}));
jest.mock('./finalize-job.processor', () => ({
  FinalizeJobProcessor: class FinalizeJobProcessorStub {},
}));
jest.mock('./notify-user.processor', () => ({
  NotifyUserProcessor: class NotifyUserProcessorStub {},
}));
jest.mock('./flow.service', () => ({
  FlowService: class FlowServiceStub {},
}));

// ---------------------------------------------------------------------------
// 9. Stub inference-job schema (pulled by processor stubs' original imports
//    when not fully mocked, and by the module itself via forFeature)
// ---------------------------------------------------------------------------
jest.mock('../inference-jobs/inference-job.schema', () => ({
  InferenceJob: { name: 'InferenceJob' },
  InferenceJobSchema: {},
}));

// ---------------------------------------------------------------------------
// Import the real module AFTER all mocks are in place.
// ---------------------------------------------------------------------------
import { QueuesModule } from './queues.module';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cfg = (vals: Record<string, unknown>) => ({
  get: (k: string, fb?: unknown) => (k in vals ? vals[k] : fb),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QueuesModule – BullModule useFactory', () => {
  it('QueuesModule is defined', () => {
    expect(QueuesModule).toBeDefined();
  });

  it('Bull factory was captured (sanity)', () => {
    expect(typeof mockCapture.bullFactory).toBe('function');
  });

  it('parses redis://user:pw@host:6380 correctly', () => {
    const result = mockCapture.bullFactory(cfg({ INFERENCE_REDIS_URL: 'redis://:pw@host:6380' }));
    expect(result).toMatchObject({
      connection: {
        host: 'host',
        port: 6380,
        password: 'pw',
        maxRetriesPerRequest: null,
      },
    });
  });

  it('defaults to port 6379 when no port is specified', () => {
    const result = mockCapture.bullFactory(cfg({ INFERENCE_REDIS_URL: 'redis://host' }));
    expect(result.connection.port).toBe(6379);
  });

  it('sets password to undefined when no password in URL', () => {
    const result = mockCapture.bullFactory(cfg({ INFERENCE_REDIS_URL: 'redis://host' }));
    expect(result.connection.password).toBeUndefined();
  });

  it('sets maxRetriesPerRequest to null (required by BullMQ)', () => {
    const result = mockCapture.bullFactory(cfg({ INFERENCE_REDIS_URL: 'redis://host' }));
    expect(result.connection.maxRetriesPerRequest).toBeNull();
  });

  it('throws when INFERENCE_REDIS_URL is missing', () => {
    expect(() => mockCapture.bullFactory(cfg({}))).toThrow(/INFERENCE_REDIS_URL/);
  });

  it('throws when INFERENCE_REDIS_URL is an empty string', () => {
    expect(() => mockCapture.bullFactory(cfg({ INFERENCE_REDIS_URL: '' }))).toThrow(
      /INFERENCE_REDIS_URL/,
    );
  });
});
