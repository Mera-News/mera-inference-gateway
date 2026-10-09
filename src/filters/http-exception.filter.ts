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

    // A body that failed to parse. body-parser's SyntaxError message carries a
    // fragment of the body itself ("Unexpected token ... "<text>" is not valid
    // JSON"), so neither its message nor its stack is logged or returned.
    if (isBodyParseError(exception)) {
      this.logger.warn(
        {
          statusCode: 400,
          path: request.url,
          method: request.method,
          error: 'request body is not valid JSON',
        },
        `HTTP 400 ${request.method} ${request.url}`,
      );
      response.status(400).json({
        statusCode: 400,
        timestamp: new Date().toISOString(),
        path: request.url,
        message: 'Request body is not valid JSON',
      });
      return;
    }

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

/** body-parser marks its parse failures `type: 'entity.parse.failed'`; Nest
 *  can also see the bare SyntaxError, or a BadRequestException wrapping it. */
function isBodyParseError(exception: unknown): boolean {
  if (exception === null || typeof exception !== 'object') return false;
  const e = exception as { type?: unknown; body?: unknown; cause?: unknown };
  if (e.type === 'entity.parse.failed') return true;
  if (exception instanceof SyntaxError && 'body' in e) return true;
  return e.cause !== undefined && e.cause !== exception && isBodyParseError(e.cause);
}
