import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

interface MockResponse {
  status: jest.Mock;
  json: jest.Mock;
}

function makeHost(): { host: ArgumentsHost; response: MockResponse } {
  const response: MockResponse = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const request = { url: '/v1/chat/completions', method: 'POST' };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('HttpExceptionFilter', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs a 4xx exception at warn (not error)', () => {
    const filter = new HttpExceptionFilter(false);
    const { host, response } = makeHost();

    filter.catch(new BadRequestException('bad input'), host);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(400);
    const body = response.json.mock.calls[0][0] as Record<string, unknown>;
    expect(body.statusCode).toBe(400);
    expect(body.message).toBe('bad input');
  });

  it('logs a 5xx exception at error (not warn)', () => {
    const filter = new HttpExceptionFilter(false);
    const { host, response } = makeHost();

    filter.catch(new InternalServerErrorException('boom'), host);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(500);
  });

  it('treats a non-HttpException as 500 with generic message', () => {
    const filter = new HttpExceptionFilter(false);
    const { host, response } = makeHost();

    filter.catch(new Error('unexpected'), host);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(response.status).toHaveBeenCalledWith(500);
    const body = response.json.mock.calls[0][0] as Record<string, unknown>;
    expect(body.message).toBe('Internal server error');
  });

  it('includes stack in development mode', () => {
    const filter = new HttpExceptionFilter(false);
    const { host, response } = makeHost();

    filter.catch(new InternalServerErrorException('boom'), host);

    const body = response.json.mock.calls[0][0] as Record<string, unknown>;
    expect(body).toHaveProperty('stack');
    expect(typeof body.stack).toBe('string');
  });

  it('omits stack in production mode', () => {
    const filter = new HttpExceptionFilter(true);
    const { host, response } = makeHost();

    filter.catch(new InternalServerErrorException('boom'), host);

    const body = response.json.mock.calls[0][0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('stack');
  });

  it('treats a non-Error, non-HttpException value as 500 with String(exception) in the log payload', () => {
    const filter = new HttpExceptionFilter(false);
    const { host, response } = makeHost();

    filter.catch('boom string', host);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(500);

    const body = response.json.mock.calls[0][0] as Record<string, unknown>;
    expect(body.message).toBe('Internal server error');
    expect(body).not.toHaveProperty('stack');

    // The log payload should carry `error: 'boom string'` (String(exception) branch).
    const logPayload = errorSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(logPayload.error).toBe('boom string');
  });

  it('uses the plain string response from an HttpException whose getResponse() returns a string', () => {
    const filter = new HttpExceptionFilter(false);
    const { host, response } = makeHost();

    filter.catch(new HttpException('plain text', 418), host);

    // 418 < 500 → warn, not error
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(418);

    const body = response.json.mock.calls[0][0] as Record<string, unknown>;
    expect(body.message).toBe('plain text');
    expect(body.statusCode).toBe(418);
  });

  it('omits stack in production mode even for a plain Error exception', () => {
    const filter = new HttpExceptionFilter(true);
    const { host, response } = makeHost();

    filter.catch(new Error('raw error'), host);

    const body = response.json.mock.calls[0][0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('stack');
    expect(body.message).toBe('Internal server error');
    expect(response.status).toHaveBeenCalledWith(500);
  });
});
