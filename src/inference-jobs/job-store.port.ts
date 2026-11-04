/**
 * Storage port for the async inference-job buffer. One adapter exists:
 * RedisJobStore, on the shared, consolidated `news-persistent-redis`
 * Memorystore instance (volatile-ttl — not a dedicated inference instance;
 * it also holds async's caches and graphql's cache under their own
 * prefixes). The composition root (JobStoreModule) binds it; everything
 * else — controller, service, processors — depends only on this interface.
 *
 * Access-control invariant: every view that can reach a client response
 * (results, notify) carries the owning `userId` non-optionally, so an adapter
 * cannot hand out results without the caller-ownership check having the data
 * it needs.
 */

export const JOB_STORE = Symbol('JOB_STORE');

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface JobRequest {
  id: string;
  body: Record<string, unknown>;
}

export interface JobResult {
  /** Null only for a finalize-time backfill entry whose original request id
   *  could no longer be recovered (the id array itself expired/was absent). */
  id: string | null;
  ok: boolean;
  /** Upstream JSON (still E2EE ciphertext inside); explicit null on failure. */
  response: unknown;
  error: string | null;
}

export interface CreateJobInput {
  userId: string;
  expoPushToken: string | null;
  e2eeSession: Record<string, string> | null;
  requests: JobRequest[];
  sharedSystem: string | null;
}

export interface RequestContext {
  request: JobRequest;
  sharedSystem: string | null;
  e2eeSession: Record<string, string> | null;
}

export interface ResultsView {
  userId: string;
  status: JobStatus;
  results: JobResult[];
}

/** A detached chat turn. `running` is the only state that ever changes. */
export type TurnStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface TurnMeta {
  userId: string;
  status: TurnStatus;
}

export interface TurnRead extends TurnMeta {
  /** Upstream's HTTP status once it answered; null before that. */
  upstreamStatus: number | null;
  /** Epoch ms of the last write, so a dead writer can be told from a slow one. */
  updatedAt: number;
  /** Stored ciphertext from the requested offset on. */
  bytes: Buffer;
  /** Length of the stored ciphertext. */
  total: number;
  /** Length the writer recorded; above `total` means the bytes were evicted. */
  recordedBytes: number;
}

/** Thrown by adapters that enforce a submit-time payload byte cap. */
export class JobPayloadTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly maxBytes: number,
  ) {
    super(`job payload ${bytes} bytes exceeds cap of ${maxBytes}`);
    this.name = 'JobPayloadTooLargeError';
  }
}

/**
 * Outcome of reserving an idempotency key at submit time:
 * - `reserved`: no prior attempt under this key; caller now owns the slot
 *   and must finalize (success) or release (throw) it.
 * - `in-progress`: another attempt under this key is still mid-flight
 *   (reserved but not yet finalized) — the caller should answer 409.
 * - `exists`: a prior attempt under this key already finalized; reuse its
 *   requestId instead of creating a new job.
 */
export type IdempotencyReservation =
  { status: 'reserved' } | { status: 'in-progress' } | { status: 'exists'; requestId: string };

export interface JobStore {
  /** Persist a new job and return its requestId (24-hex, ObjectId-shaped). */
  createJob(input: CreateJobInput): Promise<string>;

  /** Request body + job-level context a worker needs to forward upstream. */
  getRequestContext(jobId: string, requestIndex: number): Promise<RequestContext | null>;

  /**
   * Record one request's result and move the job to `processing`. Must be
   * idempotent per (jobId, requestIndex) — BullMQ delivers at-least-once.
   */
  appendResult(jobId: string, requestIndex: number, result: JobResult): Promise<void>;

  /** Mark the job completed; returns counts for logging, null if unknown. */
  finalizeJob(jobId: string): Promise<{ requestCount: number; resultCount: number } | null>;

  /** Owner + status + results for GET /results. Null if unknown/expired. */
  getResultsView(jobId: string): Promise<ResultsView | null>;

  /** Push-notification target. Null if the job is unknown/expired. */
  getNotifyInfo(jobId: string): Promise<{ expoPushToken: string | null } | null>;

  /**
   * Reserve `keyHash` (already sha256'd by the caller) for `userId` with a
   * short (60s) TTL. See `IdempotencyReservation` for the outcomes.
   */
  reserveIdempotencyKey(userId: string, keyHash: string): Promise<IdempotencyReservation>;

  /** Record the finished job's requestId against the reservation, TTL'd to
   *  the same window as the job itself (so a replay is possible for as long
   *  as the job's own results are). */
  finalizeIdempotencyKey(userId: string, keyHash: string, requestId: string): Promise<void>;

  /** Free a reservation that never finalized (create/flow/mint threw), so a
   *  retry under the same key isn't blocked for the rest of the reservation
   *  TTL. */
  releaseIdempotencyKey(userId: string, keyHash: string): Promise<void>;

  /** Claim `turnId` for `userId` as running. False when the id is already taken. */
  beginTurn(turnId: string, userId: string): Promise<boolean>;

  /** Append raw ciphertext. Rejects when the turn or its stored bytes are gone,
   *  because a later offset would then point at the wrong byte. */
  appendTurn(turnId: string, bytes: Buffer): Promise<void>;

  /** Move a running turn to a final status. A final status never changes. */
  finishTurn(turnId: string, status: TurnStatus, upstreamStatus?: number): Promise<void>;

  /** Owner + status. Null if unknown/expired. */
  getTurnMeta(turnId: string): Promise<TurnMeta | null>;

  /** Owner + status + ciphertext from byte `after`. Null if unknown/expired. */
  readTurn(turnId: string, after: number): Promise<TurnRead | null>;

  /** Liveness probe of the backing store; rejects when unreachable. */
  ping(): Promise<void>;
}
