// The redis provider instantiates a real ioredis client at provider-factory
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

describe('JobStoreModule.register', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
    jest.clearAllMocks();
  });

  it('wires RedisJobStore unconditionally (no mongo imports)', () => {
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

  it('fails fast when INFERENCE_JOBS_REDIS_URL is missing', () => {
    delete process.env.INFERENCE_JOBS_REDIS_URL;

    const mod = JobStoreModule.register();
    const providers = mod.providers as Array<{ useFactory: () => unknown }>;

    expect(() => providers[0].useFactory()).toThrow(/INFERENCE_JOBS_REDIS_URL/);
  });
});
