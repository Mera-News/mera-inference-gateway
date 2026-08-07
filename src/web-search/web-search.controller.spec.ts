import { BadGatewayException, BadRequestException, Logger } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { WebSearchController } from './web-search.controller';
import { WebSearchService } from './web-search.service';

describe('WebSearchController', () => {
  let controller: WebSearchController;
  let service: { search: jest.Mock };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    service = { search: jest.fn().mockResolvedValue([]) };
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

  it('returns { results: [] } when the service is gated off', async () => {
    await expect(controller.webSearch({ query: 'climate' })).resolves.toEqual({ results: [] });
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
});
