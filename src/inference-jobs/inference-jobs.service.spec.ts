import { Logger, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { InferenceJobsService } from './inference-jobs.service';
import { JobPayloadTooLargeError } from './job-store.port';

describe('InferenceJobsService', () => {
  let service: InferenceJobsService;
  let requestId: string;
  let storeMock: { createJob: jest.Mock };
  let flowMock: { createInferenceFlow: jest.Mock };
  let capabilityTokensMock: { mint: jest.Mock };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    requestId = randomBytes(12).toString('hex');
    storeMock = { createJob: jest.fn().mockResolvedValue(requestId) };
    flowMock = { createInferenceFlow: jest.fn().mockResolvedValue(undefined) };
    capabilityTokensMock = { mint: jest.fn().mockReturnValue('mc.tok') };

    service = new InferenceJobsService(
      storeMock as never,
      flowMock as never,
      capabilityTokensMock as never,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const fullDto = {
    requests: [
      { id: 'a', body: { x: 1 } },
      { id: 'b', body: {} },
    ],
    expoPushToken: 'ExponentPushToken[t]',
    e2eeSession: { 'X-Signing-Algo': 'ed' },
    sharedSystem: 'CIPHER',
  };

  describe('submit — full dto', () => {
    it('calls store.createJob with the correct input shape', async () => {
      await service.submit('user-1', fullDto as never);

      expect(storeMock.createJob).toHaveBeenCalledTimes(1);
      expect(storeMock.createJob).toHaveBeenCalledWith({
        userId: 'user-1',
        expoPushToken: 'ExponentPushToken[t]',
        e2eeSession: { 'X-Signing-Algo': 'ed' },
        requests: [
          { id: 'a', body: { x: 1 } },
          { id: 'b', body: {} },
        ],
        sharedSystem: 'CIPHER',
      });
    });

    it('calls flow.createInferenceFlow with jobId and requestCount', async () => {
      await service.submit('user-1', fullDto as never);

      expect(flowMock.createInferenceFlow).toHaveBeenCalledTimes(1);
      expect(flowMock.createInferenceFlow).toHaveBeenCalledWith({
        jobId: requestId,
        requestCount: 2,
      });
    });

    it('calls capabilityTokens.mint with userId and requestId', async () => {
      await service.submit('user-1', fullDto as never);

      expect(capabilityTokensMock.mint).toHaveBeenCalledTimes(1);
      expect(capabilityTokensMock.mint).toHaveBeenCalledWith({
        userId: 'user-1',
        requestId,
      });
    });

    it('returns requestId and capabilityToken', async () => {
      const result = await service.submit('user-1', fullDto as never);

      expect(result).toEqual({
        requestId,
        capabilityToken: 'mc.tok',
      });
    });
  });

  describe('submit — optional fields absent', () => {
    it('passes nulls for expoPushToken, e2eeSession and sharedSystem', async () => {
      const dtoWithoutOptionals = {
        requests: [{ id: 'a', body: { x: 1 } }],
      };

      await service.submit('user-1', dtoWithoutOptionals as never);

      const arg = storeMock.createJob.mock.calls[0][0] as Record<string, unknown>;
      expect(arg.expoPushToken).toBeNull();
      expect(arg.e2eeSession).toBeNull();
      expect(arg.sharedSystem).toBeNull();
    });

    it('collapses an e2eeSession with only undefined props to null', async () => {
      const dto = {
        requests: [{ id: 'a', body: {} }],
        e2eeSession: { 'X-Signing-Algo': undefined },
      };

      await service.submit('user-1', dto as never);

      const arg = storeMock.createJob.mock.calls[0][0] as Record<string, unknown>;
      expect(arg.e2eeSession).toBeNull();
    });
  });

  describe('submit — store failures', () => {
    it('maps JobPayloadTooLargeError to 413 PayloadTooLargeException', async () => {
      storeMock.createJob.mockRejectedValue(new JobPayloadTooLargeError(10_000_000, 5_242_880));

      await expect(service.submit('user-1', fullDto as never)).rejects.toThrow(
        PayloadTooLargeException,
      );
      expect(flowMock.createInferenceFlow).not.toHaveBeenCalled();
      expect(capabilityTokensMock.mint).not.toHaveBeenCalled();
    });

    it('maps any other store error to 503 ServiceUnavailableException', async () => {
      storeMock.createJob.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.submit('user-1', fullDto as never)).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(flowMock.createInferenceFlow).not.toHaveBeenCalled();
    });
  });
});
