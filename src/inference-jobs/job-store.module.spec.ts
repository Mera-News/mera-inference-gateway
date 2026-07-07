// The redis branch instantiates a real ioredis client at provider-factory
// time; mock it so registration can be exercised without a live server.
jest.mock('ioredis', () => {
  const instances: unknown[] = [];
  const Redis = jest.fn().mockImplementation((url: string, opts: unknown) => {
    const client = { url, opts, defineCommand: jest.fn(), quit: jest.fn() };
    instances.push(client);
    return client;
  });
  return { __esModule: true, default: Redis, _instances: instances };
});

import { JobStoreModule } from './job-store.module';
import { JOB_STORE } from './job-store.port';
import { MongoJobStore } from './mongo-job-store';

describe('JobStoreModule.register', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
    jest.clearAllMocks();
  });

  it('defaults to the mongo branch (DatabaseModule imported, MongoJobStore bound)', () => {
    delete process.env.INFERENCE_JOBS_STORE;

    const mod = JobStoreModule.register();

    expect(mod.global).toBe(true);
    expect(mod.exports).toEqual([JOB_STORE]);
    expect(mod.imports?.length).toBeGreaterThan(0);
    expect(mod.providers).toEqual(
      expect.arrayContaining([MongoJobStore, { provide: JOB_STORE, useExisting: MongoJobStore }]),
    );
  });

  it('redis branch opens no mongo imports and provides RedisJobStore from the url', () => {
    process.env.INFERENCE_JOBS_STORE = 'redis';
    process.env.INFERENCE_JOBS_REDIS_URL = 'redis://job-store:6379';

    const mod = JobStoreModule.register();

    expect(mod.imports).toBeUndefined();
    expect(mod.global).toBe(true);
    expect(mod.exports).toEqual([JOB_STORE]);

    // Resolve the factories by hand (no Nest container needed).
    const providers = mod.providers as Array<{
      provide: unknown;
      useFactory: (...args: unknown[]) => unknown;
      inject?: unknown[];
    }>;
    const clientProvider = providers[0];
    const storeProvider = providers.find((p) => p.provide === JOB_STORE)!;

    const client = clientProvider.useFactory();
    const store = storeProvider.useFactory(client) as object;
    expect(store.constructor.name).toBe('RedisJobStore');
  });

  it('redis branch fails fast when INFERENCE_JOBS_REDIS_URL is missing', () => {
    process.env.INFERENCE_JOBS_STORE = 'redis';
    delete process.env.INFERENCE_JOBS_REDIS_URL;

    const mod = JobStoreModule.register();
    const providers = mod.providers as Array<{ useFactory: () => unknown }>;

    expect(() => providers[0].useFactory()).toThrow(/INFERENCE_JOBS_REDIS_URL/);
  });

  it('rejects an unknown backend value at composition time', () => {
    process.env.INFERENCE_JOBS_STORE = 'kafka';
    expect(() => JobStoreModule.register()).toThrow(/Unknown INFERENCE_JOBS_STORE/);
  });
});
