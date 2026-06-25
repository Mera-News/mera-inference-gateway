import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ChatModule } from '../chat/chat.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { InferenceJob, InferenceJobSchema } from '../models/inference-job.schema';
import { LlmInferenceProcessor } from './llm-inference.processor';
import { FinalizeJobProcessor } from './finalize-job.processor';
import { NotifyUserProcessor } from './notify-user.processor';
import { FlowService } from './flow.service';
import {
  FINALIZE_JOB_QUEUE,
  INFERENCE_FLOW_PRODUCER,
  LLM_INFERENCE_QUEUE,
  NOTIFY_USER_QUEUE,
} from './queues.constants';

@Module({
  imports: [
    ConfigModule,
    ChatModule,
    NotificationsModule,
    MongooseModule.forFeature([{ name: InferenceJob.name, schema: InferenceJobSchema }]),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('INFERENCE_REDIS_URL', '');
        if (!url) {
          throw new Error('INFERENCE_REDIS_URL is not set');
        }
        const parsed = new URL(url);
        return {
          connection: {
            host: parsed.hostname,
            port: Number(parsed.port || 6379),
            password: parsed.password || undefined,
            maxRetriesPerRequest: null,
          },
        };
      },
    }),
    BullModule.registerQueue(
      { name: LLM_INFERENCE_QUEUE },
      { name: FINALIZE_JOB_QUEUE },
      { name: NOTIFY_USER_QUEUE },
    ),
    BullModule.registerFlowProducer({ name: INFERENCE_FLOW_PRODUCER }),
    // Register queues with Bull Board so they show up in the admin UI.
    BullBoardModule.forFeature(
      { name: LLM_INFERENCE_QUEUE, adapter: BullMQAdapter },
      { name: FINALIZE_JOB_QUEUE, adapter: BullMQAdapter },
      { name: NOTIFY_USER_QUEUE, adapter: BullMQAdapter },
    ),
  ],
  providers: [FlowService, LlmInferenceProcessor, FinalizeJobProcessor, NotifyUserProcessor],
  exports: [FlowService],
})
export class QueuesModule {}
