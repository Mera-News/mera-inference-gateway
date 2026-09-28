import {
  ConflictException,
  Logger,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { InferenceJobsService } from './inference-jobs.service';
import { JobPayloadTooLargeError } from './job-store.port';

describe('InferenceJobsService', () => {
  let service: InferenceJobsService;
  let requestId: string;
  let storeMock: {
    createJob: jest.Mock;
    reserveIdempotencyKey: jest.Mock;
    finalizeIdempotencyKey: jest.Mock;
    releaseIdempotencyKey: jest.Mock;
  };
  let flowMock: { createInferenceFlow: jest.Mock };
  let capabilityTokensMock: { mint: jest.Mock };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    requestId = randomBytes(12).toString('hex');
    storeMock = {
      createJob: jest.fn().mockResolvedValue(requestId),
      reserveIdempotencyKey: jest.fn(),
      finalizeIdempotencyKey: jest.fn().mockResolvedValue(undefined),
      releaseIdempotencyKey: jest.fn().mockResolvedValue(undefined),
    };
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

  describe('submit — idempotency key', () => {
    const idempotencyKey = 'run-1:batch-1:rel:0';
    const expectedHash = createHash('sha256').update(idempotencyKey).digest('hex');

    it('hashes the raw key before reserving and creates a new flow when the slot is free', async () => {
      storeMock.reserveIdempotencyKey.mockResolvedValue({ status: 'reserved' });

      const result = await service.submit('user-1', fullDto as never, idempotencyKey);

      expect(storeMock.reserveIdempotencyKey).toHaveBeenCalledWith('user-1', expectedHash);
      expect(storeMock.createJob).toHaveBeenCalledTimes(1);
      expect(flowMock.createInferenceFlow).toHaveBeenCalledTimes(1);
      expect(storeMock.finalizeIdempotencyKey).toHaveBeenCalledWith(
        'user-1',
        expectedHash,
        requestId,
      );
      expect(result).toEqual({ requestId, capabilityToken: 'mc.tok' });
    });

    it('throws 409 ConflictException while the key is still reserved, with no flow created', async () => {
      storeMock.reserveIdempotencyKey.mockResolvedValue({ status: 'in-progress' });

      await expect(
        service.submit('user-1', fullDto as never, idempotencyKey),
      ).rejects.toThrow(ConflictException);
      expect(storeMock.createJob).not.toHaveBeenCalled();
      expect(flowMock.createInferenceFlow).not.toHaveBeenCalled();
    });

    it('carries the idempotency-in-progress code on the 409', async () => {
      storeMock.reserveIdempotencyKey.mockResolvedValue({ status: 'in-progress' });

      try {
        await service.submit('user-1', fullDto as never, idempotencyKey);
        throw new Error('expected submit to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        expect((err as ConflictException).getResponse()).toEqual({
          code: 'idempotency-in-progress',
        });
      }
    });

    it('replays the existing requestId with a freshly minted token and creates no new flow', async () => {
      const priorRequestId = randomBytes(12).toString('hex');
      storeMock.reserveIdempotencyKey.mockResolvedValue({
        status: 'exists',
        requestId: priorRequestId,
      });

      const result = await service.submit('user-1', fullDto as never, idempotencyKey);

      expect(storeMock.createJob).not.toHaveBeenCalled();
      expect(flowMock.createInferenceFlow).not.toHaveBeenCalled();
      expect(capabilityTokensMock.mint).toHaveBeenCalledWith({
        userId: 'user-1',
        requestId: priorRequestId,
      });
      expect(result).toEqual({ requestId: priorRequestId, capabilityToken: 'mc.tok' });
    });

    it('releases the reservation and rethrows when createJob throws after reserving (crash mid-flight)', async () => {
      storeMock.reserveIdempotencyKey.mockResolvedValue({ status: 'reserved' });
      storeMock.createJob.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        service.submit('user-1', fullDto as never, idempotencyKey),
      ).rejects.toThrow(ServiceUnavailableException);

      expect(storeMock.releaseIdempotencyKey).toHaveBeenCalledWith('user-1', expectedHash);
      expect(storeMock.finalizeIdempotencyKey).not.toHaveBeenCalled();
    });

    it('releases the reservation and rethrows when the flow producer throws after reserving', async () => {
      storeMock.reserveIdempotencyKey.mockResolvedValue({ status: 'reserved' });
      flowMock.createInferenceFlow.mockRejectedValue(new Error('BULLMQ_DOWN'));

      await expect(
        service.submit('user-1', fullDto as never, idempotencyKey),
      ).rejects.toThrow('BULLMQ_DOWN');

      expect(storeMock.releaseIdempotencyKey).toHaveBeenCalledWith('user-1', expectedHash);
      expect(storeMock.finalizeIdempotencyKey).not.toHaveBeenCalled();
    });

    it('a missing idempotency key behaves exactly like today: no reservation call at all', async () => {
      await service.submit('user-1', fullDto as never);

      expect(storeMock.reserveIdempotencyKey).not.toHaveBeenCalled();
      expect(storeMock.finalizeIdempotencyKey).not.toHaveBeenCalled();
      expect(storeMock.releaseIdempotencyKey).not.toHaveBeenCalled();
      expect(flowMock.createInferenceFlow).toHaveBeenCalledTimes(1);
    });
  });
});
