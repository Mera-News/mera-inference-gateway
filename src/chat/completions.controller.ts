import { Controller, Logger, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Readable } from 'stream';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { ChatService, DeadlineElapsedError } from './chat.service';
import { InferenceQueueService } from './inference-queue.service';

/** E2EE request headers forwarded upstream (lowercase → canonical). NEAR AI
 *  v2 requires `X-Encryption-Version`. */
const E2EE_REQUEST_HEADERS: Record<string, string> = {
  'x-signing-algo': 'X-Signing-Algo',
  'x-client-pub-key': 'X-Client-Pub-Key',
  'x-model-pub-key': 'X-Model-Pub-Key',
  'x-encryption-version': 'X-Encryption-Version',
};

/** Response headers that must never be forwarded to the client. */
const BLOCKED_RESPONSE_HEADERS = new Set(['authorization', 'transfer-encoding']);

interface UpstreamCompletion {
  id?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string;
      tool_calls?: unknown[];
    };
  }>;
}

@Controller('v1')
@UseGuards(AuthGuard)
export class CompletionsController {
  private readonly logger = new Logger(CompletionsController.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly queue: InferenceQueueService,
  ) {}

  @Post('chat/completions')
  async chatCompletions(@Req() req: AuthenticatedRequest, @Res() res: Response) {
    const userId = req.user?.id;
    // Deadline stamped at request entry — see batch route for why.
    const deadlineAt = this.chatService.createDeadline();
    // Deliberately not disposed here: this handler returns while the response
    // is still streaming, so the listeners must outlive it to catch a client
    // that walks away mid-stream. They die with the req/res objects.
    const clientGone = this.clientAbortSignal(req, res);

    try {
      const e2eeHeaders = this.extractE2EEHeaders(req);
      const upstream = await this.chatService.proxyChat(req.body, e2eeHeaders, {
        deadlineAt,
        signal: clientGone.signal,
        userId,
      });

      res.status(upstream.status);

      // Forward all upstream headers except blocked ones
      upstream.headers.forEach((value, name) => {
        if (!BLOCKED_RESPONSE_HEADERS.has(name)) {
          res.setHeader(name, value);
        }
      });

      // Non-2xx from upstream: read full body, log it, then forward. Safe because
      // errors are never streamed (content-length is set by upstream) and E2EE
      // never applies to error envelopes.
      if (!upstream.ok) {
        const errorBody = await upstream.text();
        this.logger.error(
          `Upstream error user=${userId ?? 'unknown'} status=${upstream.status} body=${errorBody.slice(0, 2000)}`,
        );
        res.send(errorBody);
        return;
      }

      if (!upstream.body) {
        res.send(await upstream.text());
        return;
      }

      // Overrides for streaming compatibility
      res.setHeader('Content-Encoding', 'none');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const nodeStream = Readable.fromWeb(
        upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0],
      );

      // ChatService detaches its abort bridge once the upstream *headers*
      // arrive, and pipe() does not destroy its source when the destination
      // dies — so without this, a client that walks away mid-stream would
      // leave NEAR draining into a socket nobody reads. Destroying the
      // Readable cancels the underlying web stream and drops the connection.
      clientGone.signal.addEventListener('abort', () => nodeStream.destroy(), { once: true });

      nodeStream.pipe(res);

      nodeStream.on('error', (err) => {
        this.logger.error(
          `Proxy stream error user=${userId ?? 'unknown'}`,
          err instanceof Error ? err.stack : err,
        );
        if (!res.headersSent) {
          res.status(500).json({ error: 'Proxy stream failed' });
        }
      });
    } catch (error) {
      this.logger.error(
        `Proxy request failed user=${userId ?? 'unknown'}`,
        error instanceof Error ? error.stack : error,
      );
      if (!res.headersSent) {
        res.status(502).json({ error: 'Upstream request failed' });
      }
    }
  }

  @Post('chat/completions/batch')
  async batchChatCompletions(@Req() req: AuthenticatedRequest, @Res() res: Response) {
    const userId = req.user?.id;
    // Guard against a null/undefined body — Express 5 leaves req.body undefined
    // for POSTs whose content-type the json/urlencoded parsers don't handle.
    // Destructuring it directly would throw a TypeError (→ 500); degrade to 400.
    const { requests } = (req.body ?? {}) as { requests?: unknown[] };

    if (!Array.isArray(requests) || requests.length === 0) {
      res.status(400).json({ error: '`requests` must be a non-empty array' });
      return;
    }

    if (!this.queue.canAccept(requests.length)) {
      const snap = this.queue.snapshot();
      this.logger.warn(
        `Batch rejected (queue full) user=${userId ?? 'unknown'} ` +
          `incoming=${requests.length} active=${snap.active} waiting=${snap.waiting}`,
      );
      res.status(503).json({ error: 'Inference queue full, retry later' });
      return;
    }

    const e2eeHeaders = this.extractE2EEHeaders(req);
    const snapOnEntry = this.queue.snapshot();
    this.logger.debug(
      `Batch request user=${userId ?? 'unknown'} items=${requests.length} ` +
        `queueActive=${snapOnEntry.active} queueWaiting=${snapOnEntry.waiting} ` +
        `e2eeHeaders=${JSON.stringify(e2eeHeaders)}`,
    );

    const clientGone = this.clientAbortSignal(req, res);

    const results = await Promise.all(
      requests.map((input, index) => {
        // Stamped HERE — at request entry, synchronously, before the item is
        // handed to the queue. Inside `queue.run` it would be stamped after
        // slot acquisition and the deadline would once again cover upstream
        // only, which is exactly the bug this fixes.
        const deadlineAt = this.chatService.createDeadline();
        return this.queue.run(async () => {
          try {
            const inputModel =
              typeof input === 'object' && input !== null
                ? (input as { model?: unknown }).model
                : undefined;
            this.logger.debug(
              `Batch[${index}] sending to upstream model=${
                typeof inputModel === 'string' ? inputModel : 'default'
              }`,
            );
            const upstream = await this.chatService.proxyChat(input, e2eeHeaders, {
              deadlineAt,
              signal: clientGone.signal,
              userId,
            });

            this.logger.debug(`Batch[${index}] upstream status=${upstream.status}`);

            if (!upstream.ok) {
              const errorBody = await upstream.text();
              this.logger.warn(
                `Batch[${index}] upstream error status=${upstream.status} body=${errorBody}`,
              );
              return {
                index,
                error: `Upstream error (${upstream.status}): ${errorBody}`,
              };
            }

            const json = (await upstream.json()) as UpstreamCompletion;
            const choice = json.choices?.[0];
            this.logger.debug(
              `Batch[${index}] upstream response id=${json.id ?? 'unknown'} ` +
                `finishReason=${choice?.finish_reason ?? 'unknown'} ` +
                `hasContent=${!!choice?.message?.content} ` +
                `contentLen=${choice?.message?.content?.length ?? 0} ` +
                `hasToolCalls=${!!choice?.message?.tool_calls} ` +
                `toolCallCount=${choice?.message?.tool_calls?.length ?? 0}`,
            );

            return { index, response: json };
          } catch (error) {
            if (error instanceof DeadlineElapsedError) {
              this.logger.warn(
                `Batch[${index}] ${error.message} user=${userId ?? 'unknown'} — no upstream call made`,
              );
              return { index, error: `Request failed (${error.message})` };
            }
            this.logger.error(
              `Batch[${index}] failed user=${userId ?? 'unknown'}`,
              error instanceof Error ? error.stack : error,
            );
            return { index, error: 'Request failed' };
          }
        });
      }),
    ).finally(() => clientGone.dispose());

    this.logger.debug(
      `Batch complete user=${userId ?? 'unknown'} total=${results.length} errors=${results.filter((r) => 'error' in r).length}`,
    );
    res.json({ results });
  }

  /**
   * A signal that fires when the client goes away, so an abandoned request
   * stops burning an InferenceQueueService slot.
   *
   * Both guards are load-bearing (measured on Node 20+):
   *  - `req` 'close' fires ~1ms into a NORMAL request — as soon as the body is
   *    parsed, long before the response ends. `req.complete` is the
   *    discriminator: false only when the message was genuinely cut short.
   *    Without that guard every request would abort itself immediately.
   *  - `res` 'close' fires both on a normal finish and on a disconnect;
   *    `res.writableEnded` separates them.
   *
   * Listeners live on the per-request objects and die with them.
   */
  private clientAbortSignal(
    req: AuthenticatedRequest,
    res: Response,
  ): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();

    const onReqClose = () => {
      if (!req.complete) controller.abort();
    };
    const onResClose = () => {
      if (!res.writableEnded) controller.abort();
    };

    req.on('close', onReqClose);
    res.on('close', onResClose);

    return {
      signal: controller.signal,
      dispose: () => {
        req.off('close', onReqClose);
        res.off('close', onResClose);
      },
    };
  }

  private extractE2EEHeaders(req: AuthenticatedRequest): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [lower, canonical] of Object.entries(E2EE_REQUEST_HEADERS)) {
      const value = req.headers[lower];
      if (typeof value === 'string') headers[canonical] = value;
    }
    return headers;
  }
}
