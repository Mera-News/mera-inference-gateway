import {
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Readable } from 'stream';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { ChatService, DeadlineElapsedError } from './chat.service';
import { ChatTurnService, TURN_ID_PATTERN, type TurnRelay } from './chat-turn.service';
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

/** Longest upstream error message ever logged. */
export const UPSTREAM_ERROR_LOG_CAP = 200;

/**
 * The provider's own `error.message` (or top-level `message`) from an error
 * body, capped, with newlines flattened. Anything that is not that JSON shape
 * logs as a fixed placeholder, never as raw text.
 */
export function upstreamErrorMessage(body: string): string {
  let message: unknown;
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    message =
      typeof parsed.error === 'object' && parsed.error !== null
        ? parsed.error.message
        : (parsed.error ?? parsed.message);
  } catch {
    return '(unparsed upstream error body)';
  }
  if (typeof message !== 'string' || message.length === 0) return '(no upstream error message)';
  const flat = message.replace(/\s+/g, ' ');
  return flat.length > UPSTREAM_ERROR_LOG_CAP ? `${flat.slice(0, UPSTREAM_ERROR_LOG_CAP)}…` : flat;
}

@Controller('v1')
@UseGuards(AuthGuard)
export class CompletionsController {
  private readonly logger = new Logger(CompletionsController.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly queue: InferenceQueueService,
    private readonly turns: ChatTurnService,
  ) {}

  @Post('chat/completions')
  async chatCompletions(@Req() req: AuthenticatedRequest, @Res() res: Response) {
    const userId = req.user?.id;

    // An old app sends no header, and with the flag off it is ignored. A
    // capability token cannot read a turn back, so it gets no detached turn.
    const turnId = req.headers['x-mera-turn-id'];
    if (this.turns.enabled && typeof turnId === 'string' && !req.user?.capability) {
      if (!TURN_ID_PATTERN.test(turnId)) {
        res.status(400).json({ error: 'Invalid X-Mera-Turn-Id' });
        return;
      }
      if (await this.turns.claim(turnId, userId)) {
        const clientGone = this.clientAbortSignal(req, res);
        await this.turns.run(
          { id: turnId, userId, body: req.body, e2eeHeaders: this.extractE2EEHeaders(req) },
          this.turnRelay(res, clientGone.signal, userId),
          clientGone.signal,
        );
        return;
      }
    }

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

      // Upstream headers are copied onto `res` only on the paths that relay an
      // upstream body. A gateway-made error must carry none of them: an E2EE
      // echo on a 502 could send the app down its decrypt path.

      // Non-2xx from upstream: read full body, forward it, and log ONLY the
      // parsed error message, capped. The raw body is never logged: an error
      // envelope is not E2EE and nothing guarantees it cannot echo request text.
      if (!upstream.ok) {
        const errorBody = await upstream.text();
        this.logger.error(
          `Upstream error user=${userId ?? 'unknown'} status=${upstream.status} message=${upstreamErrorMessage(errorBody)}`,
        );
        this.forwardHeaders(res, upstream);
        res.status(upstream.status).send(errorBody);
        return;
      }

      // Not SSE: one JSON document. Buffer it so an empty or cut-off upstream
      // body becomes a 502 instead of an empty 2xx the client cannot retry.
      if (!upstream.body || !upstream.headers.get('content-type')?.includes('text/event-stream')) {
        const body = await upstream.text();
        if (!body.trim()) {
          this.logger.error(
            `Upstream empty body user=${userId ?? 'unknown'} status=${upstream.status}`,
          );
          res.status(502).json({ error: 'Upstream returned an empty body' });
          return;
        }
        this.forwardStreamingHeaders(res, upstream);
        res.status(upstream.status).send(body);
        return;
      }

      const nodeStream = Readable.fromWeb(
        upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0],
      );

      // ChatService detaches its abort bridge and its deadline timer once the
      // upstream *headers* arrive, and pipe() does not destroy its source when
      // the destination dies, so both are re-applied here. Destroying the
      // Readable cancels the underlying web stream and drops the connection.
      clientGone.signal.addEventListener('abort', () => nodeStream.destroy(), { once: true });
      let deadlineHit = false;
      const deadlineTimer = setTimeout(
        () => {
          deadlineHit = true;
          nodeStream.destroy();
        },
        Math.max(0, deadlineAt - Date.now()),
      );

      // Read the first chunk before any header goes out: a stream that ends
      // with zero bytes must become a 502, not an empty 200 that pipe() would
      // send and the app would read as a finished, empty reply.
      const chunks = nodeStream[Symbol.asyncIterator]();
      let first: IteratorResult<Uint8Array>;
      try {
        first = (await chunks.next()) as IteratorResult<Uint8Array>;
      } catch (err) {
        if (clientGone.signal.aborted) return;
        if (deadlineHit) {
          this.logger.error(
            `Upstream sent no stream bytes before the deadline user=${userId ?? 'unknown'}`,
          );
          res.status(502).json({ error: 'Upstream request failed' });
          return;
        }
        this.logger.error(
          `Proxy stream error user=${userId ?? 'unknown'}`,
          err instanceof Error ? err.stack : err,
        );
        res.status(500).json({ error: 'Proxy stream failed' });
        return;
      } finally {
        clearTimeout(deadlineTimer);
      }

      if (first.done) {
        if (clientGone.signal.aborted) return;
        this.logger.error(
          `Upstream empty stream user=${userId ?? 'unknown'} status=${upstream.status}`,
        );
        res.status(502).json({ error: 'Upstream returned an empty body' });
        return;
      }

      this.forwardStreamingHeaders(res, upstream);
      res.status(upstream.status);
      res.write(first.value);

      const rest = Readable.from({ [Symbol.asyncIterator]: () => chunks });
      rest.on('error', (err) => {
        // pipe() leaves res open on a source error, so the client hangs.
        // Destroying aborts the body so the client read rejects.
        res.destroy();
        if (clientGone.signal.aborted) return;
        this.logger.error(
          `Proxy stream error user=${userId ?? 'unknown'}`,
          err instanceof Error ? err.stack : err,
        );
      });
      rest.pipe(res);
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

  /**
   * Replays a detached chat turn, as raw bytes from offset `after` (default 0).
   *
   * - 200 `application/octet-stream`; the body is the stored bytes from `after`,
   *   possibly empty. Resume with `after + bytes received`.
   *   `X-Mera-Turn-Status`: `running` (poll again), `done` (the body reaches the
   *   end of the reply), `error` (no complete reply is coming, send the leg
   *   again), `cancelled`.
   *   `X-Mera-Turn-Total`: bytes stored so far.
   *   `X-Mera-Turn-Upstream-Status`: on a final status, if upstream answered. On
   *   a non-2xx it is the only trace of the answer: error bodies are not stored.
   * - 404 `{code:'turn-gone'}`: unknown, expired, evicted or someone else's, all
   *   identical. Also the answer with the feature off.
   * - 503 `{code:'turn-store-unavailable'}`: could not look. Try again.
   * - 400: `after` is not a byte offset.
   *
   * A final status is read before the bytes, so the body of a `done` is complete.
   * Same `AuthGuard` and default throttle as the chat route, and no read meter.
   * A capability token gets the 404: it is bound to one job, never a turn.
   */
  @Get('chat/turns/:id')
  async getTurn(
    @Param('id') id: string,
    @Query('after') after: string | undefined,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ) {
    if (after !== undefined && !/^\d{1,15}$/.test(after)) {
      res.status(400).json({ error: 'Invalid after' });
      return;
    }
    if (!this.turnRouteOpen(id, req)) {
      res.status(404).json({ code: 'turn-gone' });
      return;
    }
    try {
      const turn = await this.turns.read(id, req.user.id, Number(after ?? 0));
      if (!turn) {
        res.status(404).json({ code: 'turn-gone' });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Mera-Turn-Status', turn.status);
      res.setHeader('X-Mera-Turn-Total', String(turn.total));
      if (turn.upstreamStatus !== null) {
        res.setHeader('X-Mera-Turn-Upstream-Status', String(turn.upstreamStatus));
      }
      res.status(200).send(turn.bytes);
    } catch (error) {
      this.turnStoreFailed(res, error);
    }
  }

  /**
   * Stops a detached turn: 204, also when it had already ended, or 404
   * `{code:'turn-gone'}` / 503 as for GET. The stored bytes stay until the TTL.
   * Works across instances: the one running the turn polls the flag.
   */
  @Delete('chat/turns/:id')
  async deleteTurn(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ) {
    if (!this.turnRouteOpen(id, req)) {
      res.status(404).json({ code: 'turn-gone' });
      return;
    }
    try {
      if (await this.turns.cancel(id, req.user.id)) res.status(204).end();
      else res.status(404).json({ code: 'turn-gone' });
    } catch (error) {
      this.turnStoreFailed(res, error);
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
                `Batch[${index}] upstream error status=${upstream.status} message=${upstreamErrorMessage(errorBody)}`,
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

  private turnRouteOpen(id: string, req: AuthenticatedRequest): boolean {
    return this.turns.enabled && TURN_ID_PATTERN.test(id) && !req.user.capability;
  }

  private turnStoreFailed(res: Response, error: unknown): void {
    this.logger.error('Turn store failed', error instanceof Error ? error.stack : error);
    res.status(503).json({ code: 'turn-store-unavailable' });
  }

  /** The chat route's answers, for a turn. Once the client left, each is a no-op. */
  private turnRelay(res: Response, clientGone: AbortSignal, userId: string): TurnRelay {
    let started = false;
    return {
      fail: (status, error) => {
        if (!clientGone.aborted) res.status(status).json({ error });
      },
      upstreamError: (upstream, body) => {
        this.logger.error(
          `Upstream error user=${userId} status=${upstream.status} message=${upstreamErrorMessage(body)}`,
        );
        if (clientGone.aborted) return;
        this.forwardHeaders(res, upstream);
        res.status(upstream.status).send(body);
      },
      write: (upstream, chunk) => {
        if (clientGone.aborted) return;
        if (!started) {
          started = true;
          this.forwardStreamingHeaders(res, upstream);
          res.status(upstream.status);
        }
        // shortcut: no backpressure, a slow client buffers up to one reply in
        // memory; upgrade if detached turns ever show in instance memory.
        res.write(chunk);
      },
      end: () => {
        if (!clientGone.aborted) res.end();
      },
      send: (upstream, body) => {
        if (clientGone.aborted) return;
        this.forwardStreamingHeaders(res, upstream);
        res.status(upstream.status).send(body);
      },
      abort: () => {
        res.destroy();
      },
    };
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

  /** Every upstream header except the blocked ones. */
  private forwardHeaders(res: Response, upstream: globalThis.Response): void {
    upstream.headers.forEach((value, name) => {
      if (!BLOCKED_RESPONSE_HEADERS.has(name)) res.setHeader(name, value);
    });
  }

  /** Upstream headers plus the overrides a relayed 2xx body needs; Content-Encoding
   *  too, because fetch already decoded the body the forwarded header describes. */
  private forwardStreamingHeaders(res: Response, upstream: globalThis.Response): void {
    this.forwardHeaders(res, upstream);
    res.setHeader('Content-Encoding', 'none');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
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
