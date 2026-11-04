import { Module } from '@nestjs/common';
import { CompletionsController } from './completions.controller';
import { ChatService } from './chat.service';
import { ChatTurnService } from './chat-turn.service';
import { InferenceQueueService } from './inference-queue.service';

@Module({
  controllers: [CompletionsController],
  providers: [ChatService, ChatTurnService, InferenceQueueService],
  exports: [ChatService],
})
export class ChatModule {}
