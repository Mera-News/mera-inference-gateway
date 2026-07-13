import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { FinalizeJobProcessor } from './finalize-job.processor';
import { DEFAULT_JOB_OPTS } from './queues.constants';

describe('FinalizeJobProcessor', () => {
  let processor: FinalizeJobProcessor;
  let storeMock: { finalizeJob: jest.Mock };
  let notifyQueueMock: { add: jest.Mock };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockReturnValue(undefined);
    jest.spyOn(Logger.prototype, 'error').mockReturnValue(undefined);

    storeMock = { finalizeJob: jest.fn() };
    notifyQueueMock = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    processor = new FinalizeJobProcessor(storeMock as never, notifyQueueMock as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('process', () => {
    it('marks the job completed and enqueues notify-user, returning { jobId }', async () => {
      const jobId = randomBytes(12).toString('hex');
      storeMock.finalizeJob.mockResolvedValue({ requestCount: 3, resultCount: 1 });

      const job = { data: { jobId } } as never;
      const result = await processor.process(job);

      expect(storeMock.finalizeJob).toHaveBeenCalledTimes(1);
      expect(storeMock.finalizeJob).toHaveBeenCalledWith(jobId);

      // Verify notify queue was called
      expect(notifyQueueMock.add).toHaveBeenCalledTimes(1);
      expect(notifyQueueMock.add).toHaveBeenCalledWith('notify-user', { jobId }, DEFAULT_JOB_OPTS);

      // Verify return value
      expect(result).toEqual({ jobId });
    });

    it('rejects with /not found at finalize/ when the job is unknown and does NOT call notifyQueue.add', async () => {
      const jobId = randomBytes(12).toString('hex');
      storeMock.finalizeJob.mockResolvedValue(null);

      const job = { data: { jobId } } as never;
      await expect(processor.process(job)).rejects.toThrow(/not found at finalize/);

      expect(notifyQueueMock.add).not.toHaveBeenCalled();
    });
  });
});
