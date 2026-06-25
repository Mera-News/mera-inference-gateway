import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  constructor(private readonly isProduction: boolean = false) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    // Extra structured fields the thrower attached (e.g. the rate-limit guard's
    // `code` / `resetAt` / `limit`). Forwarded so clients can act on them.
    let extra: Record<string, unknown> = {};

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const obj = exceptionResponse as Record<string, unknown>;
        if ('message' in obj) {
          message = String(obj.message);
        } else {
          message = exception.message;
        }
        // Pass through everything except the keys we set canonically below.
        const rest = { ...obj };
        delete rest.statusCode;
        delete rest.message;
        extra = rest;
      } else {
        message = exception.message;
      }
    }

    const logPayload = {
      statusCode: status,
      path: request.url,
      method: request.method,
      ...(exception instanceof Error
        ? { error: exception.message, stack: exception.stack }
        : { error: String(exception) }),
    };
    const logMessage = `HTTP ${status} ${request.method} ${request.url}`;
    if (status < 500) {
      this.logger.warn(logPayload, logMessage);
    } else {
      this.logger.error(logPayload, logMessage);
    }

    const errorResponse: Record<string, unknown> = {
      ...extra,
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      message,
    };

    if (!this.isProduction && exception instanceof Error) {
      errorResponse.stack = exception.stack;
    }

    response.status(status).json(errorResponse);
  }
}
