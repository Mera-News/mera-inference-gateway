import { DynamicModule, Logger, Module } from '@nestjs/common';
import Redis from 'ioredis';
import { JOB_STORE } from './job-store.port';
import { RedisJobStore } from './redis-job-store';

export const JOB_STORE_REDIS_CLIENT = Symbol('JOB_STORE_REDIS_CLIENT');

/**
 * Composition root for the job-store port. Job payloads/results live on a
 * dedicated `inference-redis` Memorystore instance (INFERENCE_JOBS_REDIS_URL);
 * every key is TTL'd. BullMQ always runs on the shared INFERENCE_REDIS_URL
 * instance regardless.
 *
 * Read from process.env rather than ConfigService because module composition
 * happens before Nest DI exists; ConfigModule.forRoot has already loaded
 * .env into process.env by the time this runs (it precedes this module in
 * AppModule's imports).
 */
@Module({})
export class JobStoreModule {
  static register(): DynamicModule {
    return {
      module: JobStoreModule,
      global: true,
      providers: [
        {
          provide: JOB_STORE_REDIS_CLIENT,
          useFactory: () => {
            const url = process.env.INFERENCE_JOBS_REDIS_URL ?? '';
            if (!url) {
              throw new Error('INFERENCE_JOBS_REDIS_URL is not set');
            }
            return new Redis(url, {
              // Fail requests fast when the store is down instead of
              // queueing them — submit surfaces 503 and /health recycles
              // the instance.
              maxRetriesPerRequest: 2,
            });
          },
        },
        {
          provide: JOB_STORE,
          inject: [JOB_STORE_REDIS_CLIENT],
          useFactory: (redis: Redis) => {
            const store = new RedisJobStore(redis, {
              keyPrefix: process.env.INFERENCE_JOBS_KEY_PREFIX ?? 'inf:',
              resultTtlSeconds: Number(process.env.INFERENCE_JOBS_RESULT_TTL_SECONDS ?? 86_400),
              bodyTtlSeconds: Number(process.env.INFERENCE_JOBS_BODY_TTL_SECONDS ?? 7_200),
              maxJobBytes: Number(process.env.INFERENCE_MAX_JOB_BYTES ?? 5_242_880),
            });
            new Logger(JobStoreModule.name).log('Job store backend: redis');
            return store;
          },
        },
      ],
      exports: [JOB_STORE],
    };
  }
}
