import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Job } from 'bullmq';
import { ChatService } from '../chat/chat.service';
import { InferenceJob, InferenceJobDocument } from '../inference-jobs/inference-job.schema';
import { LLM_INFERENCE_QUEUE } from './queues.constants';

interface JobData {
  jobId: string;
  requestIndex: number;
}

export interface LlmInferenceResult {
  id: string;
  ok: boolean;
}

const LLM_INFERENCE_CONCURRENCY = Number(process.env.LLM_INFERENCE_CONCURRENCY ?? 8);

@Processor(LLM_INFERENCE_QUEUE, { concurrency: LLM_INFERENCE_CONCURRENCY })
export class LlmInferenceProcessor extends WorkerHost {
  private readonly logger = new Logger(LlmInferenceProcessor.name);

  constructor(
    private readonly chat: ChatService,
    @InjectModel(InferenceJob.name)
    private readonly inferenceJobModel: Model<InferenceJobDocument>,
  ) {
    super();
  }

  async process(job: Job<JobData>): Promise<LlmInferenceResult> {
    const { jobId, requestIndex } = job.data;

    const doc = await this.inferenceJobModel.findById(new Types.ObjectId(jobId)).lean().exec();
    if (!doc) {
      throw new Error(`Inference job ${jobId} not found`);
    }
    const request = doc.requests[requestIndex];
    if (!request) {
      throw new Error(`Inference job ${jobId} has no request at index ${requestIndex}`);
    }

    // If the job carries a sharedSystem ciphertext, prepend it as the first
    // `messages` entry before forwarding. Clients opt into this by sending
    // per-request messages without a system role and setting `sharedSystem`
    // once on the job — saves repeating the (identical) encrypted system
    // prompt across every request. Legacy jobs leave sharedSystem null and
    // embed the system inside each request's messages[] unchanged.
    const forwardBody = maybePrependSharedSystem(request.body, doc.sharedSystem);

    const headers: Record<string, string> = {};
    if (doc.e2eeSession) {
      for (const [k, v] of Object.entries(doc.e2eeSession)) {
        if (typeof v === 'string') headers[k] = v;
      }
    }

    let result:
      | { id: string; ok: true; response: unknown }
      | { id: string; ok: false; error: string };

    try {
      const upstream = await this.chat.proxyChat(forwardBody, headers);
      if (!upstream.ok) {
        const body = await upstream.text();
        this.logger.warn(
          `jobId=${jobId} requestIndex=${requestIndex} id=${request.id} upstream ${upstream.status} body=${body.slice(0, 500)}`,
        );
        result = {
          id: request.id,
          ok: false,
          error: `upstream ${upstream.status}`,
        };
      } else {
        const json = (await upstream.json()) as unknown;
        result = { id: request.id, ok: true, response: json };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `jobId=${jobId} requestIndex=${requestIndex} id=${request.id} failed: ${msg}`,
      );
      result = { id: request.id, ok: false, error: msg };
    }

    // $push the result atomically — each child writes its own row. No read/
    // modify/write race between concurrent children. Response body lives in
    // Mongo, not in BullMQ's returnvalue.
    await this.inferenceJobModel
      .updateOne(
        { _id: new Types.ObjectId(jobId) },
        {
          $push: { results: result },
          $set: { status: 'processing' },
        },
      )
      .exec();

    return { id: result.id, ok: result.ok };
  }
}

interface ChatCompletionMessage {
  role: string;
  content: unknown;
}

/**
 * Return a new chat-completions body with `sharedSystem` prepended to its
 * `messages` array as a system-role message. Returns the body untouched when
 * `sharedSystem` is null/empty or when `body.messages` is missing / not an
 * array (malformed request — let upstream reject it with a clean error).
 * Never mutates the original body; the returned object is a shallow clone
 * with a fresh messages array.
 */
function maybePrependSharedSystem(
  body: Record<string, unknown>,
  sharedSystem: string | null | undefined,
): Record<string, unknown> {
  if (!sharedSystem) return body;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return body;
  const systemMessage: ChatCompletionMessage = {
    role: 'system',
    content: sharedSystem,
  };
  return {
    ...body,
    messages: [systemMessage, ...(messages as ChatCompletionMessage[])],
  };
}
