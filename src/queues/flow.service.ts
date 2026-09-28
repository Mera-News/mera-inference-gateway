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
   * request body is pulled from the job store (Redis) by the worker. Keeps
   * BullMQ payloads tiny and centralises the source of truth in the job store.
   *
   * Children carry `ignoreDependencyOnFailure: true` — without it, a child
   * that exhausts its attempts leaves the parent stuck in `waiting-children`
   * forever (BullMQ's default), which means `removeOnComplete`/`removeOnFail`
   * never fire on it (an unbounded key on the noeviction BullMQ Redis) and
   * the job store never reaches `completed`. With it, a permanently-failed
   * child just moves to the parent's failed-dependencies list and finalize
   * still runs; `finalizeJob`'s Lua backfills that index with an explicit
   * `{ok:false, error:'child-failed'}` entry (see RedisJobStore) instead of
   * leaving it a silent hole. Parent opts are unchanged.
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
        opts: { ...DEFAULT_JOB_OPTS, ignoreDependencyOnFailure: true },
      })),
    });

    this.logger.log(`Flow created jobId=${jobId} children=${requestCount}`);
  }
}
