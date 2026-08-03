import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UPSTREAM_BASE_URL } from '../constants';

/**
 * Thrown when an item's deadline (stamped at request entry) had already elapsed
 * by the time it reached the head of the inference queue. No upstream fetch is
 * started — nobody is still waiting for the answer.
 */
export class DeadlineElapsedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadlineElapsedError';
  }
}

export interface ProxyChatOptions {
  /**
   * Absolute epoch-ms deadline for this item, stamped when the request entered
   * the controller (see `ChatService.createDeadline`). Bounds queue wait +
   * upstream together. Omitted ⇒ a fresh full-budget deadline from now.
   */
  deadlineAt?: number;
  /** External signal (e.g. the client disconnected); aborts the upstream fetch. */
  signal?: AbortSignal;
  /** Caller identity, for attribution in the timeout log only. */
  userId?: string;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly timeoutMs: number;
  private readonly apiKey: string;

  constructor(private configService: ConfigService) {
    const key = this.configService.get<string>('NEAR_AI_API_KEY', '');
    if (!key) {
      throw new Error('NEAR_AI_API_KEY environment variable is not set');
    }
    this.apiKey = key;
    // 120s default: a cold NEAR model (first request after the fleet spins one
    // up) routinely takes >30s to first byte. At 30s the gateway aborted and
    // returned 502 while the model was still warming, and the app — which
    // retries 502 — produced a multi-minute retry storm that could never
    // complete. Env-overridable via UPSTREAM_TIMEOUT_MS.
    this.timeoutMs = this.configService.get<number>('UPSTREAM_TIMEOUT_MS', 120_000);
  }

  /**
   * Stamp a deadline for an item entering the gateway. Callers do this at
   * request entry (controller) so that `UPSTREAM_TIMEOUT_MS` bounds
   * *queue wait + upstream* rather than upstream alone.
   */
  createDeadline(): number {
    return Date.now() + this.timeoutMs;
  }

  /** Pure proxy: forward body as-is upstream. */
  async proxyChat(
    body: unknown,
    extraHeaders?: Record<string, string>,
    options?: ProxyChatOptions,
  ): Promise<globalThis.Response> {
    const startedAt = Date.now();
    const deadlineAt = options?.deadlineAt ?? startedAt + this.timeoutMs;
    const remainingMs = deadlineAt - startedAt;
    const model = this.modelOf(body);
    const user = options?.userId ?? 'unknown';

    // The budget was consumed while this item waited for a queue slot — the
    // client has already given up (or is about to). Fail now instead of
    // starting a fresh full-length upstream call nobody is waiting for.
    if (remainingMs <= 0) {
      this.logger.error(
        `deadline elapsed in queue after ${-remainingMs}ms past limit ` +
          `(limit=${this.timeoutMs}ms) model=${model} user=${user}`,
      );
      throw new DeadlineElapsedError('deadline elapsed in queue');
    }

    // Client already gone before the slot freed up: same reasoning, no fetch.
    if (options?.signal?.aborted) {
      this.logger.warn(`client disconnected before dispatch model=${model} user=${user}`);
      throw new DeadlineElapsedError('client disconnected before dispatch');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);

    // Bridge the external signal instead of AbortSignal.any: the runtime image
    // is node:20-alpine and .any needs Node >= 20.3, so the listener bridge is
    // the always-safe form. Detached in the finally below.
    const onExternalAbort = () => controller.abort();
    options?.signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const response = await fetch(`${UPSTREAM_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const elapsedMs = Date.now() - startedAt;
      this.logger.debug(`upstream responded status=${response.status} elapsedMs=${elapsedMs}`);
      return response;
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      if ((error as { name?: string })?.name === 'AbortError') {
        if (options?.signal?.aborted) {
          this.logger.warn(
            `upstream request aborted after ${elapsedMs}ms (client disconnected) ` +
              `model=${model} user=${user}`,
          );
        } else {
          this.logger.error(
            `upstream request timed out after ${elapsedMs}ms ` +
              `(limit=${this.timeoutMs}ms remainingAtDispatch=${remainingMs}ms) ` +
              `model=${model} user=${user}`,
          );
        }
      } else {
        this.logger.error(
          `upstream fetch failed after ${elapsedMs}ms: ${(error as Error)?.message ?? String(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  /**
   * Model id off the request body, for log attribution only. Never touches
   * `messages` — the gateway does not read message content.
   */
  private modelOf(body: unknown): string {
    const model =
      typeof body === 'object' && body !== null ? (body as { model?: unknown }).model : undefined;
    return typeof model === 'string' ? model : 'default';
  }
}
