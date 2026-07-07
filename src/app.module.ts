import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module';
import { ChatModule } from './chat/chat.module';
import { AttestationModule } from './attestation/attestation.module';
import { HealthController } from './health/health.controller';
import { InferenceJobsModule } from './inference-jobs/inference-jobs.module';
import { JobStoreModule } from './inference-jobs/job-store.module';
import { QueuesModule } from './queues/queues.module';
import { NotificationsModule } from './notifications/notifications.module';
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
    ThrottlerModule.forRootAsync({
      useFactory: (configService: ConfigService) => [
        {
          ttl: configService.get<number>('THROTTLE_TTL', 60) * 1000,
          limit: configService.get<number>('THROTTLE_LIMIT', 30),
        },
      ],
      inject: [ConfigService],
    }),
    // Job-store composition root: binds JOB_STORE to Mongo (default) or the
    // dedicated Redis instance based on INFERENCE_JOBS_STORE.
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
