import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisThrottlerStorage } from './redis-throttler.storage';

export const THROTTLE_REDIS_CLIENT = Symbol('THROTTLE_REDIS_CLIENT');

/**
 * Composition root for the Redis-backed rate-limit store.
 *
 * Runs on the SHARED BullMQ instance (INFERENCE_REDIS_URL), not the dedicated
 * job-store one: throttle counters are small, short-lived and expendable,
 * while the job store is volatile-ttl and holds real payloads.
 *
 * ── KEY NAMESPACE ─────────────────────────────────────────────────────────
 * `${BULLMQ_PREFIX}:throttle:` — BULLMQ_PREFIX defaults to 'bull' here, THE
 * SAME LITERAL used by src/queues/queues.module.ts. Keep the two defaults
 * identical: staging sets BULLMQ_PREFIX=bull-stg to stay off prod's keys, and
 * if these two defaults ever drift apart, staging's throttle buckets silently
 * merge into prod's with no visible symptom.
 *   prod    -> bull:throttle:<sha256>
 *   staging -> bull-stg:throttle:<sha256>
 * (The guard sha256-hashes the tracker, so no raw userId reaches Redis.)
 *
 * Unlike JobStoreModule this reads ConfigService, not process.env: these
 * factories run inside Nest DI, so the bootstrap-time exception that applies
 * to job-store.module.ts does not apply here.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: THROTTLE_REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('INFERENCE_REDIS_URL', '');
        if (!url) {
          throw new Error('INFERENCE_REDIS_URL is not set');
        }
        const logger = new Logger('ThrottleRedis');
        const client = new Redis(url, {
          // A rate-limit check must never outlive the request it guards. The
          // failure that actually bites under a burst is Redis going SLOW,
          // not Redis refusing: without this every request stalls behind it.
          commandTimeout: 300,
          // Reject immediately while disconnected instead of queueing commands
          // that would all fire at once on reconnect. This is what turns a
          // connection failure into the fail-open path rather than a stall.
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
        });
        // ioredis is an EventEmitter: an 'error' with no listener is an
        // unhandled error event and would take the process down, which is the
        // exact opposite of failing open. Storage logs state transitions; this
        // handler exists so the event is always consumed.
        client.on('error', (err: Error) => logger.debug(`Throttle redis: ${err.message}`));
        return client;
      },
    },
    {
      provide: RedisThrottlerStorage,
      inject: [THROTTLE_REDIS_CLIENT, ConfigService],
      useFactory: (redis: Redis, config: ConfigService) => {
        const prefix = config.get<string>('BULLMQ_PREFIX', 'bull');
        return new RedisThrottlerStorage(redis, `${prefix}:throttle:`);
      },
    },
  ],
  exports: [RedisThrottlerStorage],
})
export class ThrottlingModule {}
