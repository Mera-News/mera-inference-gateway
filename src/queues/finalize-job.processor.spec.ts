import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { FinalizeJobProcessor } from './finalize-job.processor';
import { DEFAULT_JOB_OPTS } from './queues.constants';

describe('FinalizeJobProcessor', () => {
  let processor: FinalizeJobProcessor;
  let modelMock: { findOneAndUpdate: jest.Mock };
  let notifyQueueMock: { add: jest.Mock };
  let execMock: jest.Mock;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockReturnValue(undefined);
    jest.spyOn(Logger.prototype, 'error').mockReturnValue(undefined);

    execMock = jest.fn();
    modelMock = {
      findOneAndUpdate: jest.fn().mockReturnValue({
        lean: () => ({ exec: execMock }),
      }),
    };
    notifyQueueMock = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    processor = new FinalizeJobProcessor(modelMock as never, notifyQueueMock as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('process', () => {
    it('marks the job completed and enqueues notify-user, returning { jobId }', async () => {
      const jobId = new Types.ObjectId().toString();
      const doc = { requests: [{}, {}, {}], results: [{}] };
      execMock.mockResolvedValue(doc);

      const job = { data: { jobId } } as never;
      const result = await processor.process(job);

      // Verify findOneAndUpdate call args
      expect(modelMock.findOneAndUpdate).toHaveBeenCalledTimes(1);
      const [filter, update, options] = modelMock.findOneAndUpdate.mock.calls[0] as [
        { _id: Types.ObjectId },
        { $set: { status: string; completedAt: Date } },
        { returnDocument: string; projection: object },
      ];

      expect(filter._id).toBeInstanceOf(Types.ObjectId);
      expect(filter._id.toString()).toBe(jobId);

      expect(update.$set.status).toBe('completed');
      expect(update.$set.completedAt).toBeInstanceOf(Date);

      expect(options).toEqual({
        returnDocument: 'after',
        projection: { results: 1, requests: 1 },
      });

      // Verify notify queue was called
      expect(notifyQueueMock.add).toHaveBeenCalledTimes(1);
      expect(notifyQueueMock.add).toHaveBeenCalledWith(
        'notify-user',
        { jobId },
        DEFAULT_JOB_OPTS,
      );

      // Verify return value
      expect(result).toEqual({ jobId });
    });

    it('rejects with /not found at finalize/ when doc is null and does NOT call notifyQueue.add', async () => {
      const jobId = new Types.ObjectId().toString();
      execMock.mockResolvedValue(null);

      const job = { data: { jobId } } as never;
      await expect(processor.process(job)).rejects.toThrow(/not found at finalize/);

      expect(notifyQueueMock.add).not.toHaveBeenCalled();
    });
  });
});
