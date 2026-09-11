import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module';
import { CapabilityTokenService } from './auth/capability-token.service';
import { ThrottlingModule } from './throttling/throttling.module';
import { RedisThrottlerStorage } from './throttling/redis-throttler.storage';
import { createThrottleTracker } from './throttling/throttle-tracker';
import { ChatModule } from './chat/chat.module';
import { AttestationModule } from './attestation/attestation.module';
import { HealthController } from './health/health.controller';
import { InferenceJobsModule } from './inference-jobs/inference-jobs.module';
import { JobStoreModule } from './inference-jobs/job-store.module';
import { QueuesModule } from './queues/queues.module';
import { NotificationsModule } from './notifications/notifications.module';
import { WebSearchModule } from './web-search/web-search.module';
import { FactCheckClaimsModule } from './fact-check-claims/fact-check-claims.module';
import { BullBoardModule } from '@bull-board/nestjs';
import { ExpressAdapter } from '@bull-board/express';

/**
 * GCP Cloud Logging severity levels mapping.
 * Maps Pino numeric levels to GCP severity strings.
 */
const PINO_TO_GCP_SEVERITY: Record<number, string> = {
  10: 'DEBUG',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARNING',
  50: 'ERROR',
  60: 'CRITICAL',
};

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
    }),
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const nodeEnv = configService.get<string>('NODE_ENV', 'development');
        const isProduction = nodeEnv === 'production';

        return {
          pinoHttp: {
            level: configService.get<string>('LOG_LEVEL', isProduction ? 'warn' : 'debug'),
            formatters: {
              level: (label: string, number: number) => ({
                severity: PINO_TO_GCP_SEVERITY[number] || 'DEFAULT',
                level: label,
              }),
              log: (object: Record<string, unknown>) => {
                const { msg, ...rest } = object;
                return { ...rest, message: msg };
              },
            },
            base: {
              serviceName: 'mera-inference-gateway',
              environment: nodeEnv,
            },
            timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
            transport: isProduction
              ? undefined
              : {
                  target: 'pino-pretty',
                  options: {
                    colorize: true,
                    translateTime: 'SYS:standard',
                    ignore: 'pid,hostname',
                    singleLine: false,
                  },
                },
            serializers: {
              req: (req: { method: string; url: string }) => ({
                method: req.method,
                url: req.url,
              }),
              res: (res: { statusCode: number }) => ({
                statusCode: res.statusCode,
              }),
              err: (err: Error) => ({
                type: err.constructor.name,
                message: err.message,
                stack: err.stack,
              }),
            },
            autoLogging: isProduction
              ? {
                  ignore: (req: { url?: string }) => req.url === '/health',
                }
              : false,
            customProps: () => ({
              context: 'HTTP',
            }),
          },
        };
      },
    }),
    // Rate limiting is shared across instances (Redis) and keyed by user, not
    // by IP. The object form is required: ThrottlerModule only honours a
    // custom `storage` when options are an object -- pass an array and it
    // silently falls back to the in-process Map, which is the bug this fixes.
    //
    // `getTracker` runs BEFORE AuthGuard (global guard vs controller-scoped),
    // so it picks a bucket from the bearer token itself. See throttle-tracker.ts:
    // the JWT read there is deliberately unverified and grants nothing.
    ThrottlerModule.forRootAsync({
      imports: [ThrottlingModule, AuthModule],
      useFactory: (
        configService: ConfigService,
        storage: RedisThrottlerStorage,
        capabilityTokens: CapabilityTokenService,
      ) => ({
        throttlers: [
          {
            // ConfigService.get<number> does NOT coerce -- the generic is a
            // type assertion over process.env strings. Without Number() a set
            // THROTTLE_LIMIT arrives as a string and only works by accident.
            ttl: Number(configService.get<number>('THROTTLE_TTL', 60)) * 1000,
            limit: Number(configService.get<number>('THROTTLE_LIMIT', 30)),
          },
        ],
        storage,
        getTracker: createThrottleTracker(capabilityTokens),
      }),
      inject: [ConfigService, RedisThrottlerStorage, CapabilityTokenService],
    }),
    // Job-store composition root: binds JOB_STORE to the dedicated Redis
    // instance (INFERENCE_JOBS_REDIS_URL).
    JobStoreModule.register(),
    // Mount Bull Board at /queues. Basic-auth middleware is applied in
    // main.ts before this router handles any request, so the UI is protected.
    BullBoardModule.forRoot({
      route: '/queues',
      adapter: ExpressAdapter,
    }),
    AuthModule,
    ChatModule,
    AttestationModule,
    // Plaintext by necessity and off by default — see the privacy note in
    // README.md / CLAUDE.md. Separate route, separate posture from the
    // E2EE inference path.
    WebSearchModule,
    // ClaimReview lookup — same plaintext posture and the same off-by-default
    // gate as WebSearchModule, against Google's Fact Check Tools index.
    FactCheckClaimsModule,
    NotificationsModule,
    QueuesModule,
    InferenceJobsModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
