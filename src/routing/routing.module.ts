import { MiddlewareConsumer, Module, NestMiddleware, Injectable } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ConfigModule } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { ProbeProcessor } from './probe.processor';
import { RoutingController } from './routing.controller';
import { ROUTING_PROBE_QUEUE, RoutingService } from './routing.service';

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
  providers: [RoutingService, ProbeProcessor, RoutingHeaderMiddleware],
  exports: [RoutingService, RoutingHeaderMiddleware],
})
export class RoutingModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RoutingHeaderMiddleware).forRoutes('{*path}');
  }
}
