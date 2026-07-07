/**
 * Storage port for the async inference-job buffer. Two adapters exist:
 * MongoJobStore (legacy, Atlas TTL collection) and RedisJobStore (dedicated
 * Memorystore instance). The composition root (JobStoreModule) binds one of
 * them from INFERENCE_JOBS_STORE; everything else — controller, service,
 * processors — depends only on this interface.
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
  id: string;
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

  /** Liveness probe of the backing store; rejects when unreachable. */
  ping(): Promise<void>;
}
