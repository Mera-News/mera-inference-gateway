import {
  BadGatewayException,
  BadRequestException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { SEARCH_UNAVAILABLE_CODE } from '../search-unavailable';
import { FactCheckClaimsController } from './fact-check-claims.controller';
import { FactCheckClaimsService } from './fact-check-claims.service';

describe('FactCheckClaimsController', () => {
  let controller: FactCheckClaimsController;
  let service: { searchClaims: jest.Mock };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    service = { searchClaims: jest.fn().mockResolvedValue([]) };
    controller = new FactCheckClaimsController(service as unknown as FactCheckClaimsService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('is guarded by AuthGuard', () => {
    const guards = Reflect.getMetadata('__guards__', FactCheckClaimsController) as unknown[];
    expect(guards).toContain(AuthGuard);
  });

  it('is mounted at POST /v1/fact-check-claims and answers 200', () => {
    expect(Reflect.getMetadata('path', FactCheckClaimsController)).toBe('v1');
    expect(Reflect.getMetadata('path', FactCheckClaimsController.prototype.factCheckClaims)).toBe(
      'fact-check-claims',
    );
    expect(
      Reflect.getMetadata('__httpCode__', FactCheckClaimsController.prototype.factCheckClaims),
    ).toBe(200);
  });

  it('wraps the service results in { claimReviews } and forwards all three params', async () => {
    const reviews = [{ url: 'https://u.invalid' }];
    service.searchClaims.mockResolvedValue(reviews);

    await expect(
      controller.factCheckClaims({ query: 'a claim', languageCode: 'en', maxAgeDays: 30 }),
    ).resolves.toEqual({ claimReviews: reviews });
    expect(service.searchClaims).toHaveBeenCalledWith('a claim', 'en', 30);
  });

  it('returns { claimReviews: [] } for a claim nobody has reviewed', async () => {
    // The honest empty, behind a 200. This is the normal outcome for most news
    // and must never be rendered as a failure.
    await expect(controller.factCheckClaims({ query: 'a claim' })).resolves.toEqual({
      claimReviews: [],
    });
  });

  it('passes a 503 search-unavailable through instead of flattening it to a 502', async () => {
    service.searchClaims.mockRejectedValue(
      new ServiceUnavailableException({
        code: SEARCH_UNAVAILABLE_CODE,
        reason: 'disabled',
        message: 'Fact check lookup is disabled on this gateway',
      }),
    );

    await expect(controller.factCheckClaims({ query: 'a claim' })).rejects.toThrow(
      ServiceUnavailableException,
    );
    await controller
      .factCheckClaims({ query: 'a claim' })
      .catch((error: ServiceUnavailableException) => {
        expect(error.getStatus()).toBe(503);
        expect(error.getResponse()).toMatchObject({ code: SEARCH_UNAVAILABLE_CODE });
      });
  });

  it('passes a 400 from the service straight through', async () => {
    service.searchClaims.mockRejectedValue(new BadRequestException('Query must be at least 2'));
    await expect(controller.factCheckClaims({ query: 'a' })).rejects.toThrow(BadRequestException);
  });

  it('maps an upstream failure to 502', async () => {
    service.searchClaims.mockRejectedValue(new Error('lookup failed with status 500'));
    await expect(controller.factCheckClaims({ query: 'a claim' })).rejects.toThrow(
      BadGatewayException,
    );
  });

  it('maps a non-Error rejection to 502 as well', async () => {
    service.searchClaims.mockRejectedValue('boom');
    await expect(controller.factCheckClaims({ query: 'a claim' })).rejects.toThrow(
      BadGatewayException,
    );
  });

  it('never logs the claim text on failure', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    service.searchClaims.mockRejectedValue(new Error('upstream died'));

    await expect(controller.factCheckClaims({ query: 'distinctive-secret-claim' })).rejects.toThrow(
      BadGatewayException,
    );

    const emitted = errorSpy.mock.calls.flat().join(' ');
    expect(emitted).not.toContain('distinctive-secret-claim');
  });
});
