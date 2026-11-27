import type { Provider } from '../constants';

/** Profile id = `<provider>/<harness folder>`; `model` is what the provider is sent. */
export const PROFILES: Record<string, { provider: Provider; model: string }> = {
  'near/qwen3.8-27b': { provider: 'near', model: 'Qwen/Qwen3.8-27B' },
  'near/qwen3.6-35b-a3b': { provider: 'near', model: 'Qwen/Qwen3.6-35B-A3B-FP8' },
  'redpill/qwen3.8-27b': { provider: 'redpill', model: 'qwen/qwen3.8-27b' },
  'redpill/gemma-4-31b': { provider: 'redpill', model: 'google/gemma-4-31b-it' },
};

/** Chat lanes: ordered by SPEED alone, fastest first, among profiles that pass the evals.
 *  Measured end to end with E2EE through staging on the follow corpus (2026-11-27, p50 per
 *  turn): Qwen3.6 2.6s, RedPill Qwen3.8 2.4-3.6s, Gemma 5.0s, NEAR Qwen3.8 16-19s. */
export const CHAT_MODELS = [
  'near/qwen3.6-35b-a3b',
  'redpill/qwen3.8-27b',
  'redpill/gemma-4-31b',
  'near/qwen3.8-27b',
];
/** Scoring, topics and background: ordered by speed AND cost, among profiles that pass the
 *  evals. RedPill serves no batch or async job, so its profiles come last. */
export const SCORING_MODELS = [
  'near/qwen3.6-35b-a3b',
  'near/qwen3.8-27b',
  'redpill/qwen3.8-27b',
  'redpill/gemma-4-31b',
];

/** Default ranking per lane. Mirrors the app's built-in fallback table. No fact-check lane: the quick
 *  fact check rides chat-single; a build that still asks for it falls back to its own table. */
export const LANES: Record<string, string[]> = {
  'chat-tools': CHAT_MODELS,
  'chat-single': CHAT_MODELS,
  scoring: SCORING_MODELS,
  topics: SCORING_MODELS,
  background: SCORING_MODELS,
};

export function profileFor(provider: Provider, model: string): string | undefined {
  return Object.keys(PROFILES).find(
    (id) => PROFILES[id].provider === provider && PROFILES[id].model === model,
  );
}
