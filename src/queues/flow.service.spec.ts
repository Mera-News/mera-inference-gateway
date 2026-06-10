import { Logger } from '@nestjs/common';
import { FlowService } from './flow.service';
import { DEFAULT_JOB_OPTS, FINALIZE_JOB_QUEUE, LLM_INFERENCE_QUEUE } from './queues.constants';

describe('FlowService', () => {
  let service: FlowService;
  let flowProducerMock: { add: jest.Mock };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockReturnValue(undefined);
    jest.spyOn(Logger.prototype, 'error').mockReturnValue(undefined);

    flowProducerMock = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    service = new FlowService(flowProducerMock as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createInferenceFlow', () => {
    it('calls flowProducer.add once with the correct parent + 3 children for requestCount=3', async () => {
      await service.createInferenceFlow({ jobId: 'J', requestCount: 3 });

      expect(flowProducerMock.add).toHaveBeenCalledTimes(1);

      const [flowArg] = flowProducerMock.add.mock.calls[0] as [
        {
          name: string;
          queueName: string;
          data: { jobId: string };
          opts: typeof DEFAULT_JOB_OPTS;
          children: Array<{
            name: string;
            queueName: string;
            data: { jobId: string; requestIndex: number };
            opts: typeof DEFAULT_JOB_OPTS;
          }>;
        },
      ];

      // Assert parent shape
      expect(flowArg.name).toBe('finalize-job');
      expect(flowArg.queueName).toBe(FINALIZE_JOB_QUEUE);
      expect(flowArg.data).toEqual({ jobId: 'J' });
      expect(flowArg.opts).toEqual(DEFAULT_JOB_OPTS);

      // Assert children count
      expect(flowArg.children).toHaveLength(3);

      // Assert each child's shape
      for (let i = 0; i < 3; i++) {
        expect(flowArg.children[i]).toEqual({
          name: 'llm-inference',
          queueName: LLM_INFERENCE_QUEUE,
          data: { jobId: 'J', requestIndex: i },
          opts: DEFAULT_JOB_OPTS,
        });
      }
    });

    it('produces an empty children array when requestCount=0', async () => {
      await service.createInferenceFlow({ jobId: 'J', requestCount: 0 });

      expect(flowProducerMock.add).toHaveBeenCalledTimes(1);
      const [flowArg] = flowProducerMock.add.mock.calls[0] as [{ children: unknown[] }];
      expect(flowArg.children).toEqual([]);
    });

    it('produces a single child with requestIndex=0 when requestCount=1', async () => {
      await service.createInferenceFlow({ jobId: 'J', requestCount: 1 });

      expect(flowProducerMock.add).toHaveBeenCalledTimes(1);
      const [flowArg] = flowProducerMock.add.mock.calls[0] as [
        {
          children: Array<{
            name: string;
            queueName: string;
            data: { jobId: string; requestIndex: number };
            opts: typeof DEFAULT_JOB_OPTS;
          }>;
        },
      ];

      expect(flowArg.children).toHaveLength(1);
      expect(flowArg.children[0]).toEqual({
        name: 'llm-inference',
        queueName: LLM_INFERENCE_QUEUE,
        data: { jobId: 'J', requestIndex: 0 },
        opts: DEFAULT_JOB_OPTS,
      });
    });
  });
});
