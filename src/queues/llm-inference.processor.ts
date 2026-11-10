import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { ChatService } from '../chat/chat.service';
import { upstreamErrorMessage } from '../chat/completions.controller';
import { parseProvider } from '../constants';
import { PROVIDER_JOB_KEY } from '../inference-jobs/provider-key';
import { JOB_STORE, type JobResult, type JobStore } from '../inference-jobs/job-store.port';
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
    @Inject(JOB_STORE) private readonly store: JobStore,
  ) {
    super();
  }

  async process(job: Job<JobData>): Promise<LlmInferenceResult> {
    const { jobId, requestIndex } = job.data;

    const context = await this.store.getRequestContext(jobId, requestIndex);
    if (!context) {
      throw new Error(`Inference job ${jobId} has no request at index ${requestIndex}`);
    }
    const { request, sharedSystem, e2eeSession } = context;

    // If the job carries a sharedSystem ciphertext, prepend it as the first
    // `messages` entry before forwarding. Clients opt into this by sending
    // per-request messages without a system role and setting `sharedSystem`
    // once on the job — saves repeating the (identical) encrypted system
    // prompt across every request. Legacy jobs leave sharedSystem null and
    // embed the system inside each request's messages[] unchanged.
    const forwardBody = maybePrependSharedSystem(request.body, sharedSystem);

    const { [PROVIDER_JOB_KEY]: providerValue, ...headers } = e2eeSession ?? {};
    const provider = parseProvider(providerValue) ?? 'near';

    let result: JobResult;

    try {
      const upstream = await this.chat.proxyChat(forwardBody, headers, { provider });
      if (!upstream.ok) {
        const body = await upstream.text();
        this.logger.warn(
          `jobId=${jobId} requestIndex=${requestIndex} id=${request.id} upstream ${upstream.status} message=${upstreamErrorMessage(body)}`,
        );
        result = {
          id: request.id,
          ok: false,
          response: null,
          error: `upstream ${upstream.status}`,
        };
      } else {
        const json = (await upstream.json()) as unknown;
        result = { id: request.id, ok: true, response: json, error: null };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `jobId=${jobId} requestIndex=${requestIndex} id=${request.id} failed: ${msg}`,
      );
      result = { id: request.id, ok: false, response: null, error: msg };
    }

    // Each child records its own row keyed by requestIndex — idempotent under
    // BullMQ's at-least-once delivery, no read/modify/write race between
    // concurrent children. Response body lives in the job store, not in
    // BullMQ's returnvalue.
    await this.store.appendResult(jobId, requestIndex, result);

    // request.id (not result.id): always a real string on this path —
    // result.id is only ever null for a finalize-time backfill entry, which
    // never flows through this processor.
    return { id: request.id, ok: result.ok };
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
