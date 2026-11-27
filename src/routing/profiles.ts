import type { Provider } from '../constants';

/** Profile id = `<provider>/<harness folder>`; `model` is what the provider is sent. */
export const PROFILES: Record<string, { provider: Provider; model: string }> = {
  'near/qwen3.8-27b': { provider: 'near', model: 'Qwen/Qwen3.8-27B' },
  'near/qwen3.6-35b-a3b': { provider: 'near', model: 'Qwen/Qwen3.6-35B-A3B-FP8' },
  'redpill/qwen3.8-27b': { provider: 'redpill', model: 'qwen/qwen3.8-27b' },
  'redpill/gemma-4-31b': { provider: 'redpill', model: 'google/gemma-4-31b-it' },
  'redpill/kimi-k2.6': { provider: 'redpill', model: 'moonshotai/kimi-k2.6' },
};

// Fastest first, measured end to end with E2EE through staging on the follow corpus
// (2026-11-27, 22 turns each, p50): qwen3.6 2.6s, redpill qwen3.8 2.4-3.6s, gemma 5.0s,
// near qwen3.8 16-19s with 503s. Every arm left made a card on at least 17 of 22.
const CHAT = [
  'near/qwen3.6-35b-a3b',
  'redpill/qwen3.8-27b',
  'redpill/gemma-4-31b',
  'near/qwen3.8-27b',
];
const BULK = [
  'near/qwen3.6-35b-a3b',
  'near/qwen3.8-27b',
  'redpill/qwen3.8-27b',
  'redpill/gemma-4-31b',
];
// Kimi K2.6 is in no lane: RedPill stopped offering E2EE v2 for it (every attestation on
// 2026-11-27 lacked the secp256k1 key), so the app's key check refuses it on every call.

/** Default ranking per lane. Mirrors the app's built-in fallback table. No fact-check lane: the quick
 *  fact check rides chat-single; a build that still asks for it falls back to its own table. */
export const LANES: Record<string, string[]> = {
  'chat-tools': CHAT,
  'chat-single': CHAT,
  scoring: BULK,
  topics: BULK,
  background: BULK,
};

export function profileFor(provider: Provider, model: string): string | undefined {
  return Object.keys(PROFILES).find(
    (id) => PROFILES[id].provider === provider && PROFILES[id].model === model,
  );
}
