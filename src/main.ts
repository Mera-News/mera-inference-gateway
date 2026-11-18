import * as dotenv from 'dotenv';
dotenv.config({ quiet: true });

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

  // The Bull Board admin UI sits behind HTTP basic auth, and only when the
  // password is long enough to survive unlimited guessing. Otherwise the whole
  // route answers 503, even with the right credentials.
  const bullBoardUser = configService.get<string>('BULLBOARD_ADMIN_USERNAME', '');
  const bullBoardPass = configService.get<string>('BULLBOARD_ADMIN_PASSWORD', '');
  if (bullBoardUser && bullBoardPass.length >= 32) {
    app.use(
      '/queues',
      basicAuth({
        users: { [bullBoardUser]: bullBoardPass },
        challenge: true,
        realm: 'mera-inference-gateway',
      }),
    );
  } else {
    logger.warn(
      `Queue admin board is off: ${bullBoardUser && bullBoardPass ? 'BULLBOARD_ADMIN_PASSWORD is shorter than 32 characters' : 'BULLBOARD_ADMIN_USERNAME or BULLBOARD_ADMIN_PASSWORD is unset'}`,
    );
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
