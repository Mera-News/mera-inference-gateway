import * as dotenv from 'dotenv';
dotenv.config();

import helmet from 'helmet';
import compression from 'compression';
import basicAuth from 'express-basic-auth';
import { json, urlencoded, type Request, type Response } from 'express';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { HttpExceptionFilter } from './filters/http-exception.filter';
import { AppModule } from './app.module';
async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  const logger = app.get(Logger);
  app.useLogger(logger);

  const configService = app.get(ConfigService);
  const bodyLimit = configService.get<string>('INFERENCE_BODY_LIMIT', '50mb');

  app.use(json({ limit: bodyLimit }));
  app.use(urlencoded({ extended: true, limit: bodyLimit }));

  app.use(
    compression({
      filter: (req: Request, res: Response) => {
        if (req.path === '/v1/chat/completions') return false;
        return compression.filter(req, res);
      },
    }),
  );

  app.enableShutdownHooks();

  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  const isProduction = configService.get<string>('NODE_ENV') === 'production';

  app.use(helmet());

  // Protect the Bull Board admin UI with HTTP basic auth. The route itself is
  // registered by BullBoardModule in app.module.ts; this middleware runs
  // ahead of it. Credentials come from Secret Manager (shared with the
  // mera-bull-board service).
  const bullBoardUser = configService.get<string>('BULLBOARD_ADMIN_USERNAME', '');
  const bullBoardPass = configService.get<string>('BULLBOARD_ADMIN_PASSWORD', '');
  if (bullBoardUser && bullBoardPass) {
    app.use(
      '/queues',
      basicAuth({
        users: { [bullBoardUser]: bullBoardPass },
        challenge: true,
        realm: 'mera-inference-gateway',
      }),
    );
  } else {
    // Refuse the route entirely if creds aren't configured. Fail-closed: we
    // never want bull-board exposed unauthenticated.
    app.use('/queues', (_req: Request, res: Response) =>
      res.status(503).send('Bull Board disabled'),
    );
  }

  app.useGlobalFilters(new HttpExceptionFilter(isProduction));

  app.enableCors({
    origin: configService.get<string>('CORS_ORIGIN', 'http://localhost:8081'),
    credentials: true,
  });

  const port = configService.get<number>('PORT', 8080);
  await app.listen(port);
  logger.log(`Inference gateway running on port ${port}`);
}
void bootstrap();
