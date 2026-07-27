import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UPSTREAM_BASE_URL } from '../constants';

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

  /** Pure proxy: forward body as-is upstream. */
  async proxyChat(
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<globalThis.Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();

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
        this.logger.error(
          `upstream request timed out after ${elapsedMs}ms (limit=${this.timeoutMs}ms)`,
        );
      } else {
        this.logger.error(
          `upstream fetch failed after ${elapsedMs}ms: ${(error as Error)?.message ?? String(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
