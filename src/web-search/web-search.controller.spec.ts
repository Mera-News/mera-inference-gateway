import {
  BadGatewayException,
  BadRequestException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { SEARCH_UNAVAILABLE_CODE } from '../search-unavailable';
import { WebSearchController } from './web-search.controller';
import { WebSearchService } from './web-search.service';

describe('WebSearchController', () => {
  let controller: WebSearchController;
  let service: { search: jest.Mock; searchMany: jest.Mock };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    service = {
      search: jest.fn().mockResolvedValue([]),
      searchMany: jest.fn().mockResolvedValue([]),
    };
    controller = new WebSearchController(service as unknown as WebSearchService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('is guarded by AuthGuard', () => {
    const guards = Reflect.getMetadata('__guards__', WebSearchController) as unknown[];
    expect(guards).toContain(AuthGuard);
  });

  it('is mounted at POST /v1/web-search and answers 200', () => {
    expect(Reflect.getMetadata('path', WebSearchController)).toBe('v1');
    expect(Reflect.getMetadata('path', WebSearchController.prototype.webSearch)).toBe('web-search');
    expect(Reflect.getMetadata('__httpCode__', WebSearchController.prototype.webSearch)).toBe(200);
  });

  it('wraps the service results in { results }', async () => {
    const hits = [{ title: 't', url: 'https://u.invalid', snippet: 's' }];
    service.search.mockResolvedValue(hits);

    await expect(controller.webSearch({ query: 'climate' })).resolves.toEqual({ results: hits });
    expect(service.search).toHaveBeenCalledWith('climate');
  });

  it('returns { results: [] } for a genuine zero-hit search', async () => {
    // The ONLY empty this route still emits: a 200 meaning "we asked Brave and
    // Brave had nothing". Every unavailable state 503s instead — see below.
    await expect(controller.webSearch({ query: 'climate' })).resolves.toEqual({ results: [] });
  });

  it('passes a 503 search-unavailable through instead of flattening it to a 502', async () => {
    // A 502 would tell the client "the provider failed", which a fact-checker
    // can shrug off; the 503 + code is what makes it report `blocked`. The
    // controller's own instanceof-HttpException branch is what preserves it.
    service.search.mockRejectedValue(
      new ServiceUnavailableException({
        code: SEARCH_UNAVAILABLE_CODE,
        reason: 'disabled',
        message: 'Web search is disabled on this gateway',
      }),
    );

    await expect(controller.webSearch({ query: 'climate' })).rejects.toThrow(
      ServiceUnavailableException,
    );
    await controller.webSearch({ query: 'climate' }).catch((error: ServiceUnavailableException) => {
      expect(error.getStatus()).toBe(503);
      expect(error.getResponse()).toMatchObject({ code: SEARCH_UNAVAILABLE_CODE });
    });
  });

  it('passes a 400 from the service straight through', async () => {
    service.search.mockRejectedValue(
      new BadRequestException('Query must be at least 2 characters'),
    );
    await expect(controller.webSearch({ query: 'a' })).rejects.toThrow(BadRequestException);
  });

  it('maps an upstream failure to 502', async () => {
    service.search.mockRejectedValue(new Error('Brave search failed with status 500'));
    await expect(controller.webSearch({ query: 'climate' })).rejects.toThrow(BadGatewayException);
  });

  it('maps a non-Error rejection to 502 as well', async () => {
    service.search.mockRejectedValue('boom');
    await expect(controller.webSearch({ query: 'climate' })).rejects.toThrow(BadGatewayException);
  });

  it('never logs the query text on failure', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    service.search.mockRejectedValue(new Error('upstream died'));

    await expect(controller.webSearch({ query: 'distinctive-secret-terms' })).rejects.toThrow(
      BadGatewayException,
    );

    const emitted = errorSpy.mock.calls.flat().join(' ');
    expect(emitted).not.toContain('distinctive-secret-terms');
  });

  describe('the two request shapes', () => {
    it('routes a `queries` body to searchMany and wraps it in { searches }', async () => {
      const entries = [{ query: 'alpha', results: [] }];
      service.searchMany.mockResolvedValue(entries);

      await expect(controller.webSearch({ queries: ['alpha'] })).resolves.toEqual({
        searches: entries,
      });
      expect(service.searchMany).toHaveBeenCalledWith(['alpha']);
      expect(service.search).not.toHaveBeenCalled();
    });

    // The fallback in the app keys on THIS 400: an app build newer than the
    // gateway sends `queries`, the old ValidationPipe strips it, the body
    // arrives empty and this is the answer that tells the client to retry one
    // query at a time. Changing it to anything else strands that fallback.
    it('400s an empty body rather than guessing a shape', async () => {
      await expect(controller.webSearch({})).rejects.toBeInstanceOf(BadRequestException);
      expect(service.search).not.toHaveBeenCalled();
      expect(service.searchMany).not.toHaveBeenCalled();
    });

    it('400s a body carrying both shapes', async () => {
      await expect(controller.webSearch({ query: 'a', queries: ['b'] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(service.search).not.toHaveBeenCalled();
      expect(service.searchMany).not.toHaveBeenCalled();
    });
  });
});
