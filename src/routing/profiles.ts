import type { Provider } from '../constants';

/** Profile id = `<provider>/<harness folder>`; `model` is what the provider is sent. */
export const PROFILES: Record<string, { provider: Provider; model: string }> = {
  'near/qwen3.8-27b': { provider: 'near', model: 'Qwen/Qwen3.8-27B' },
  'near/qwen3.6-35b-a3b': { provider: 'near', model: 'Qwen/Qwen3.6-35B-A3B-FP8' },
  'redpill/qwen3.8-27b': { provider: 'redpill', model: 'qwen/qwen3.8-27b' },
  'redpill/gemma-4-31b': { provider: 'redpill', model: 'google/gemma-4-31b-it' },
  'redpill/kimi-k2.6': { provider: 'redpill', model: 'moonshotai/kimi-k2.6' },
};

const CHAT = [
  'near/qwen3.8-27b',
  'near/qwen3.6-35b-a3b',
  'redpill/qwen3.8-27b',
  'redpill/gemma-4-31b',
];
const BULK = [
  'near/qwen3.6-35b-a3b',
  'near/qwen3.8-27b',
  'redpill/qwen3.8-27b',
  'redpill/gemma-4-31b',
];
/** Kimi K2.6 qualified for chat and topics only (below the Qwen bar on scoring, untested on fact-check and background). */
const KIMI = 'redpill/kimi-k2.6';

/** Default ranking per lane. Mirrors the app's built-in fallback table. */
export const LANES: Record<string, string[]> = {
  'chat-tools': [...CHAT, KIMI],
  'chat-single': [...CHAT, KIMI],
  'fact-check': CHAT,
  scoring: BULK,
  topics: [...BULK, KIMI],
  background: BULK,
};

export function profileFor(provider: Provider, model: string): string | undefined {
  return Object.keys(PROFILES).find(
    (id) => PROFILES[id].provider === provider && PROFILES[id].model === model,
  );
}
