import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ExpoPushService } from './expo-push.service';

@Module({
  imports: [ConfigModule],
  providers: [ExpoPushService],
  exports: [ExpoPushService],
})
export class NotificationsModule {}
