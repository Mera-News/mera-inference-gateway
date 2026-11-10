import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  JOB_STORE,
  type JobStore,
  type TurnRead,
  type TurnStatus,
} from '../inference-jobs/job-store.port';
import type { Provider } from '../constants';
import { ChatService } from './chat.service';

/** How often the tee writes to Redis and checks its deadlines. */
const TICK_MS = 250;
/** Ticks between reads of the stored status, for a Stop from another instance. */
const CANCEL_POLL_TICKS = 4;
/** A Redis that does not answer the claim in time costs resumability, never the reply. */
const CLAIM_TIMEOUT_MS = 1_000;
/** Beyond the idle timeout a live writer has failed or written, so `running` is a dead instance. */
const STALE_GRACE_MS = 30_000;

export const TURN_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

type StopReason = 'cancelled' | 'deadline' | 'idle' | 'abandoned';

/** Where a turn's reply goes while a client is attached. Its calls no-op once it left. */
export interface TurnRelay {
  /** A gateway-made error, before any upstream byte was relayed. */
  fail(status: number, error: string): void;
  upstreamError(upstream: globalThis.Response, body: string): void;
  /** One SSE chunk. */
  write(upstream: globalThis.Response, chunk: Uint8Array): void;
  end(): void;
  /** A whole buffered (`stream: false`) body. */
  send(upstream: globalThis.Response, body: Buffer): void;
  /** Cut the response, so a partial reply is never read as a finished one. */
  abort(): void;
}

export interface TurnRequest {
  id: string;
  userId: string;
  body: unknown;
  e2eeHeaders: Record<string, string>;
  provider?: Provider;
}

/** Raw ciphertext on its way to Redis. Writes stay in order; one failure ends them for
 *  good, because a gap would corrupt every later offset. */
class TurnTee {
  private pending: Uint8Array[] = [];
  private written: Promise<void> = Promise.resolve();
  private bytes = 0;
  dead = false;

  constructor(
    private readonly store: JobStore,
    private readonly turnId: string,
    private readonly maxBytes: number,
    private readonly logger: Logger,
  ) {}

  push(chunk: Uint8Array): void {
    if (this.dead) return;
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      this.kill('over the size cap');
      return;
    }
    this.pending.push(chunk);
  }

  flush(): Promise<void> {
    this.written = this.written.then(async () => {
      if (this.dead || this.pending.length === 0) return;
      const batch = Buffer.concat(this.pending);
      this.pending = [];
      try {
        await this.store.appendTurn(this.turnId, batch);
      } catch (err) {
        this.kill(err instanceof Error ? err.message : 'write failed');
      }
    });
    return this.written;
  }

  private kill(why: string): void {
    this.dead = true;
    this.pending = [];
    this.logger.warn(`turn ${this.turnId} is no longer resumable: ${why}`);
    this.store.finishTurn(this.turnId, 'error').catch(() => undefined);
  }
}

/**
 * Chat turns that outlive their connection. The caller's socket is only a
 * viewer: upstream keeps running after it drops, and the raw bytes are teed to
 * the job store for `GET /v1/chat/turns/:id`. Bytes are never parsed or logged.
 */
@Injectable()
export class ChatTurnService {
  private readonly logger = new Logger(ChatTurnService.name);
  private readonly running = new Map<
    string,
    { userId: string; halt: (reason: StopReason) => void }
  >();
  readonly enabled: boolean;
  private readonly deadlineMs: number;
  private readonly idleMs: number;
  private readonly maxBytes: number;

  constructor(
    config: ConfigService,
    private readonly chat: ChatService,
    @Inject(JOB_STORE) private readonly store: JobStore,
  ) {
    this.enabled = config.get<string>('CHAT_TURN_RESUME_ENABLED') === 'true';
    // ConfigService does not coerce, and a typo in a tuning knob must not fail a turn.
    const positive = (name: string, fallback: number) => {
      const value = Number(config.get(name));
      return value > 0 ? value : fallback;
    };
    this.deadlineMs = positive('CHAT_TURN_DEADLINE_MS', 600_000);
    // Matches UPSTREAM_TIMEOUT_MS: a cold NEAR model can stay silent this long.
    this.idleMs = positive('CHAT_TURN_IDLE_TIMEOUT_MS', 120_000);
    this.maxBytes = positive('CHAT_TURN_MAX_BYTES', 16 * 1024 * 1024);
  }

  /** False when the id is taken or Redis is not answering; the caller then proxies as usual. */
  async claim(id: string, userId: string): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.store.beginTurn(id, userId),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), CLAIM_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      this.logger.warn(`turn claim failed: ${err instanceof Error ? err.message : 'unknown'}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Runs a claimed turn to its end, whatever happens to the client. Never rejects. */
  async run(turn: TurnRequest, relay: TurnRelay, clientGone: AbortSignal): Promise<void> {
    const { id, userId } = turn;
    const tee = new TurnTee(this.store, id, this.maxBytes, this.logger);
    const stop = new AbortController();
    let stopped: StopReason | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    const halt = (reason: StopReason) => {
      if (stopped) return;
      stopped = reason;
      stop.abort();
      reader?.cancel().catch(() => undefined);
    };
    this.running.set(id, { userId, halt });

    const startedAt = Date.now();
    let lastByteAt = startedAt;
    let ticks = 0;
    const ticker = setInterval(() => {
      const now = Date.now();
      if (now - startedAt >= this.deadlineMs) halt('deadline');
      else if (now - lastByteAt >= this.idleMs) halt('idle');
      // Nobody is reading and nothing can replay it, so it is only being paid for.
      else if (tee.dead && clientGone.aborted) halt('abandoned');
      void tee.flush();
      if (++ticks % CANCEL_POLL_TICKS === 0) {
        this.store
          .getTurnMeta(id)
          .then((meta) => meta?.status === 'cancelled' && halt('cancelled'))
          .catch(() => undefined);
      }
    }, TICK_MS);

    let status: TurnStatus = 'error';
    let upstreamStatus: number | undefined;
    let relayed = false;
    const fail = (httpStatus: number, error: string) => {
      if (relayed) relay.abort();
      else relay.fail(httpStatus, error);
    };
    const failStopped = () => {
      if (stopped === 'cancelled') {
        status = 'cancelled';
        relay.abort();
        return;
      }
      this.logger.error(`turn ${id} stopped (${stopped}) user=${userId}`);
      fail(502, 'Upstream request failed');
    };

    try {
      const upstream = await this.chat.proxyChat(turn.body, turn.e2eeHeaders, {
        provider: turn.provider,
        deadlineAt: this.chat.createDeadline(),
        signal: stop.signal,
        userId,
      });
      upstreamStatus = upstream.status;
      lastByteAt = Date.now();

      const relayChunks =
        upstream.ok && upstream.headers.get('content-type')?.includes('text/event-stream');
      const held: Uint8Array[] = [];
      let received = 0;
      reader = upstream.body?.getReader();
      while (reader && !stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        lastByteAt = Date.now();
        received += value.length;
        // An upstream error envelope is not E2EE, so it is relayed and never stored.
        if (upstream.ok) tee.push(value);
        if (relayChunks) {
          relay.write(upstream, value);
          relayed = true;
        } else {
          held.push(value);
        }
      }

      const body = Buffer.concat(held);
      if (stopped) {
        failStopped();
      } else if (!upstream.ok) {
        relay.upstreamError(upstream, body.toString());
      } else if (received === 0 || (!relayChunks && !body.toString().trim())) {
        this.logger.error(`Upstream empty body turn=${id} user=${userId}`);
        relay.fail(502, 'Upstream returned an empty body');
      } else {
        status = 'done';
        if (relayChunks) relay.end();
        else relay.send(upstream, body);
      }
    } catch (err) {
      if (stopped) {
        failStopped();
      } else {
        this.logger.error(
          `Turn stream error user=${userId}`,
          err instanceof Error ? err.stack : err,
        );
        // Same answers as the plain route.
        if (upstreamStatus === undefined) fail(502, 'Upstream request failed');
        else fail(500, 'Proxy stream failed');
      }
    } finally {
      clearInterval(ticker);
      this.running.delete(id);
      await tee.flush();
      await this.store
        .finishTurn(id, status === 'done' && tee.dead ? 'error' : status, upstreamStatus)
        .catch((err: unknown) => {
          this.logger.warn(
            `turn ${id} status not stored: ${err instanceof Error ? err.message : 'unknown'}`,
          );
        });
    }
  }

  /** Null for an unknown, expired or evicted turn and for another account's. */
  async read(id: string, userId: string, after: number): Promise<TurnRead | null> {
    const turn = await this.store.readTurn(id, after);
    if (!turn || turn.userId !== userId) return null;
    // A `done` over evicted bytes would read as a finished, empty reply.
    if (turn.total < turn.recordedBytes) return null;
    const writerDied =
      turn.status === 'running' && Date.now() - turn.updatedAt > this.idleMs + STALE_GRACE_MS;
    return writerDied ? { ...turn, status: 'error' } : turn;
  }

  /** Stops the turn here, or flags it for the instance running it. False when it is not theirs. */
  async cancel(id: string, userId: string): Promise<boolean> {
    const local = this.running.get(id);
    if (local?.userId === userId) {
      local.halt('cancelled');
      return true;
    }
    const meta = await this.store.getTurnMeta(id);
    if (!meta || meta.userId !== userId) return false;
    await this.store.finishTurn(id, 'cancelled');
    return true;
  }
}
