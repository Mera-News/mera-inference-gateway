import { DynamicModule, Logger, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import Redis from 'ioredis';
import { DatabaseModule } from '../database/database.module';
import { InferenceJob, InferenceJobSchema } from '../models/inference-job.schema';
import { JOB_STORE } from './job-store.port';
import { MongoJobStore } from './mongo-job-store';
import { RedisJobStore } from './redis-job-store';

export const JOB_STORE_REDIS_CLIENT = Symbol('JOB_STORE_REDIS_CLIENT');

/**
 * Composition root for the job-store port. The backend is chosen once at
 * boot from INFERENCE_JOBS_STORE (`mongo` default — prod stays on Atlas
 * until the cutover flips the env):
 *
 *   mongo — Atlas TTL collection via DatabaseModule (INFERENCE_MONGODB_URI)
 *   redis — dedicated inference-redis instance (INFERENCE_JOBS_REDIS_URL);
 *           no Mongo connection is opened at all in this mode.
 *
 * Read from process.env rather than ConfigService because module composition
 * happens before Nest DI exists; ConfigModule.forRoot has already loaded
 * .env into process.env by the time this runs (it precedes this module in
 * AppModule's imports).
 */
@Module({})
export class JobStoreModule {
  static register(): DynamicModule {
    const backend = process.env.INFERENCE_JOBS_STORE ?? 'mongo';

    if (backend === 'redis') {
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

    if (backend !== 'mongo') {
      throw new Error(`Unknown INFERENCE_JOBS_STORE "${backend}" (expected "mongo" or "redis")`);
    }

    return {
      module: JobStoreModule,
      global: true,
      imports: [
        DatabaseModule,
        MongooseModule.forFeature([{ name: InferenceJob.name, schema: InferenceJobSchema }]),
      ],
      providers: [MongoJobStore, { provide: JOB_STORE, useExisting: MongoJobStore }],
      exports: [JOB_STORE],
    };
  }
}
