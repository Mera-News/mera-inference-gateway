import { MiddlewareConsumer, Module, NestMiddleware, Injectable } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { NextFunction, Request, Response } from 'express';
import { ProbeProcessor } from './probe.processor';
import { RoutingController } from './routing.controller';
import { ROUTING_PROBE_QUEUE, ROUTING_REDIS, RoutingService } from './routing.service';

/** Stamps `X-Mera-Routing` before any handler, guard or filter runs, so every
 *  response carries it: success, upstream error, gateway-made error, stream. */
@Injectable()
export class RoutingHeaderMiddleware implements NestMiddleware {
  constructor(private readonly routing: RoutingService) {}

  async use(_req: Request, res: Response, next: NextFunction): Promise<void> {
    res.setHeader('X-Mera-Routing', String(await this.routing.version()));
    next();
  }
}

@Module({
  imports: [
    ConfigModule,
    // The root BullModule config (INFERENCE_REDIS_URL, prefix) comes from QueuesModule.
    BullModule.registerQueue({ name: ROUTING_PROBE_QUEUE }),
    BullBoardModule.forFeature({ name: ROUTING_PROBE_QUEUE, adapter: BullMQAdapter }),
  ],
  controllers: [RoutingController],
  providers: [
    {
      // The routing table lives on the BullMQ Redis (noeviction), not the volatile job store.
      provide: ROUTING_REDIS,
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => {
        const url = config.get<string>('INFERENCE_REDIS_URL', '');
        if (!url) throw new Error('INFERENCE_REDIS_URL is not set');
        const client = new Redis(url, {
          // A table read must never outlive the request it stamps: fail fast, serve the last version.
          commandTimeout: 500,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
        });
        client.on('error', () => undefined); // reads surface their own failure; this only stops an unhandled event
        // Writes need a connected client; wait briefly, but never block or crash boot on Redis.
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 3_000);
          client.once('ready', () => {
            clearTimeout(t);
            resolve();
          });
        });
        return client;
      },
    },
    RoutingService,
    ProbeProcessor,
    RoutingHeaderMiddleware,
  ],
  exports: [RoutingService, RoutingHeaderMiddleware],
})
export class RoutingModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RoutingHeaderMiddleware).forRoutes('{*path}');
  }
}
