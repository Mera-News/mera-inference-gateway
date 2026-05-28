import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Expo, type ExpoPushMessage } from 'expo-server-sdk';

export interface SilentPushArgs {
  to: string;
  data: Record<string, unknown>;
}

@Injectable()
export class ExpoPushService {
  private readonly logger = new Logger(ExpoPushService.name);
  private readonly expo: Expo;

  constructor(config: ConfigService) {
    const accessToken = config.get<string>('EXPO_ACCESS_TOKEN', '');
    this.expo = new Expo({ accessToken: accessToken || undefined });
  }

  async sendSilent(args: SilentPushArgs): Promise<void> {
    if (!Expo.isExpoPushToken(args.to)) {
      this.logger.warn(`Invalid Expo push token, skipping: ${String(args.to)}`);
      return;
    }

    const message: ExpoPushMessage = {
      to: args.to,
      data: args.data,
      priority: 'high',
      _contentAvailable: true,
    };

    const chunks = this.expo.chunkPushNotifications([message]);
    for (const chunk of chunks) {
      try {
        const tickets = await this.expo.sendPushNotificationsAsync(chunk);
        for (const t of tickets) {
          if (t.status === 'error') {
            this.logger.warn(
              `Expo push ticket error: ${t.message} details=${JSON.stringify(t.details)}`,
            );
          }
        }
      } catch (err) {
        this.logger.error(
          `Expo push send failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
