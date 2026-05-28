import { Injectable, Logger } from '@nestjs/common';
import { InjectFlowProducer } from '@nestjs/bullmq';
import type { FlowProducer } from 'bullmq';
import {
  DEFAULT_JOB_OPTS,
  FINALIZE_JOB_QUEUE,
  INFERENCE_FLOW_PRODUCER,
  LLM_INFERENCE_QUEUE,
} from './queues.constants';

export interface CreateInferenceFlowParams {
  jobId: string;
  requestCount: number;
}

@Injectable()
export class FlowService {
  private readonly logger = new Logger(FlowService.name);

  constructor(
    @InjectFlowProducer(INFERENCE_FLOW_PRODUCER)
    private readonly flowProducer: FlowProducer,
  ) {}

  /**
   * Spawn a BullMQ Flow: `finalize-job` parent with N `llm-inference`
   * children. Each child carries only `{ jobId, requestIndex }` — the actual
   * request body is pulled from Mongo by the worker. Keeps BullMQ payloads
   * tiny and centralises the source of truth in the inference_jobs doc.
   */
  async createInferenceFlow(params: CreateInferenceFlowParams): Promise<void> {
    const { jobId, requestCount } = params;

    await this.flowProducer.add({
      name: 'finalize-job',
      queueName: FINALIZE_JOB_QUEUE,
      data: { jobId },
      opts: DEFAULT_JOB_OPTS,
      children: Array.from({ length: requestCount }, (_, requestIndex) => ({
        name: 'llm-inference',
        queueName: LLM_INFERENCE_QUEUE,
        data: { jobId, requestIndex },
        opts: DEFAULT_JOB_OPTS,
      })),
    });

    this.logger.log(`Flow created jobId=${jobId} children=${requestCount}`);
  }
}
