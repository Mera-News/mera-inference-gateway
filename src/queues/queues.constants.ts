export const LLM_INFERENCE_QUEUE = 'llm-inference';
export const FINALIZE_JOB_QUEUE = 'finalize-job';
export const NOTIFY_USER_QUEUE = 'notify-user';
export const INFERENCE_FLOW_PRODUCER = 'inference-flow';

/** Default opts applied to every BullMQ job (including Flow children + parent).
 *  Closes the parent-job leak that existed when the original flow had no
 *  removeOnComplete/removeOnFail on the parent. */
export const DEFAULT_JOB_OPTS = {
  attempts: 3,
  // Exponential backoff from 2s (2s, 4s, 8s) rides out transient upstream blips.
  backoff: { type: 'exponential' as const, delay: 2000 },
  // Keep completed jobs 1h / max 500 — long enough for clients to poll results
  // without letting Redis grow unbounded.
  removeOnComplete: { age: 3600, count: 500 },
  // Retain failed jobs 24h for post-mortem debugging before auto-pruning.
  removeOnFail: { age: 86400 },
};
