import { Module } from '@nestjs/common';
import { CompletionsController } from './completions.controller';
import { ChatService } from './chat.service';
import { InferenceQueueService } from './inference-queue.service';

@Module({
  controllers: [CompletionsController],
  providers: [ChatService, InferenceQueueService],
  exports: [ChatService],
})
export class ChatModule {}
