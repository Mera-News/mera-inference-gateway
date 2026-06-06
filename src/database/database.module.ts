import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

/**
 * Dedicated Mongo connection for the inference gateway. Separate URI from the
 * main news-graphql MongoDB — this DB only holds ephemeral inference_jobs
 * documents (TTL 24h).
 */
@Module({
  imports: [
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const uri = config.get<string>('INFERENCE_MONGODB_URI', '');
        if (!uri) {
          throw new Error('INFERENCE_MONGODB_URI is not set');
        }
        return {
          uri,
          maxPoolSize: config.get<number>('INFERENCE_MONGODB_MAX_POOL_SIZE', 3),
          minPoolSize: 0,
          maxIdleTimeMS: 30_000,
          serverSelectionTimeoutMS: 10_000,
        };
      },
    }),
  ],
})
export class DatabaseModule {}
