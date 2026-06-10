import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { InferenceJobsService } from './inference-jobs.service';

describe('InferenceJobsService', () => {
  let service: InferenceJobsService;
  let oid: Types.ObjectId;
  let modelMock: { create: jest.Mock };
  let flowMock: { createInferenceFlow: jest.Mock };
  let capabilityTokensMock: { mint: jest.Mock };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    oid = new Types.ObjectId();
    modelMock = { create: jest.fn().mockResolvedValue({ _id: oid }) };
    flowMock = { createInferenceFlow: jest.fn().mockResolvedValue(undefined) };
    capabilityTokensMock = { mint: jest.fn().mockReturnValue('mc.tok') };

    service = new InferenceJobsService(
      modelMock as never,
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
    it('calls model.create with the correct document shape', async () => {
      await service.submit('user-1', fullDto as never);

      expect(modelMock.create).toHaveBeenCalledTimes(1);
      const arg = modelMock.create.mock.calls[0][0] as Record<string, unknown>;

      expect(arg).toMatchObject({
        userId: 'user-1',
        status: 'pending',
        requests: [
          { id: 'a', body: { x: 1 } },
          { id: 'b', body: {} },
        ],
        e2eeSession: { 'X-Signing-Algo': 'ed' },
        sharedSystem: 'CIPHER',
        results: [],
        expoPushToken: 'ExponentPushToken[t]',
      });

      expect(arg.createdAt).toBeInstanceOf(Date);
      expect(arg.expiresAt).toBeInstanceOf(Date);
    });

    it('calls flow.createInferenceFlow with jobId and requestCount', async () => {
      await service.submit('user-1', fullDto as never);

      expect(flowMock.createInferenceFlow).toHaveBeenCalledTimes(1);
      expect(flowMock.createInferenceFlow).toHaveBeenCalledWith({
        jobId: oid.toString(),
        requestCount: 2,
      });
    });

    it('calls capabilityTokens.mint with userId and requestId', async () => {
      await service.submit('user-1', fullDto as never);

      expect(capabilityTokensMock.mint).toHaveBeenCalledTimes(1);
      expect(capabilityTokensMock.mint).toHaveBeenCalledWith({
        userId: 'user-1',
        requestId: oid.toString(),
      });
    });

    it('returns requestId and capabilityToken', async () => {
      const result = await service.submit('user-1', fullDto as never);

      expect(result).toEqual({
        requestId: oid.toString(),
        capabilityToken: 'mc.tok',
      });
    });
  });

  describe('submit — e2eeSession and sharedSystem undefined', () => {
    it('passes e2eeSession: null and sharedSystem: null to model.create', async () => {
      const dtoWithoutOptionals = {
        requests: [{ id: 'a', body: { x: 1 } }],
        expoPushToken: 'ExponentPushToken[t]',
      };

      await service.submit('user-1', dtoWithoutOptionals as never);

      const arg = modelMock.create.mock.calls[0][0] as Record<string, unknown>;
      expect(arg.e2eeSession).toBeNull();
      expect(arg.sharedSystem).toBeNull();
    });
  });

  describe('submit — TTL', () => {
    it('sets expiresAt exactly 24 hours after createdAt', async () => {
      await service.submit('user-1', fullDto as never);

      const arg = modelMock.create.mock.calls[0][0] as Record<string, unknown>;
      const createdAt = arg.createdAt as Date;
      const expiresAt = arg.expiresAt as Date;

      expect(expiresAt.getTime() - createdAt.getTime()).toBe(24 * 60 * 60 * 1000);
    });
  });
});
