import type { Provider } from '../constants';

/** Profile id = `<provider>/<harness folder>`; `model` is what the provider is sent. */
export const PROFILES: Record<string, { provider: Provider; model: string }> = {
  'near/qwen3.8-27b': { provider: 'near', model: 'Qwen/Qwen3.8-27B' },
  'near/qwen3.6-35b-a3b': { provider: 'near', model: 'Qwen/Qwen3.6-35B-A3B-FP8' },
  'redpill/qwen3.8-27b': { provider: 'redpill', model: 'qwen/qwen3.8-27b' },
};

const CHAT_RANKING = ['near/qwen3.8-27b', 'near/qwen3.6-35b-a3b', 'redpill/qwen3.8-27b'];
const BULK_RANKING = ['near/qwen3.6-35b-a3b', 'near/qwen3.8-27b', 'redpill/qwen3.8-27b'];

/** Default ranking per lane. Mirrors the app's built-in fallback table. */
export const LANES: Record<string, string[]> = {
  'chat-tools': CHAT_RANKING,
  'chat-single': CHAT_RANKING,
  'fact-check': CHAT_RANKING,
  scoring: BULK_RANKING,
  topics: BULK_RANKING,
  background: BULK_RANKING,
};

export function profileFor(provider: Provider, model: string): string | undefined {
  return Object.keys(PROFILES).find(
    (id) => PROFILES[id].provider === provider && PROFILES[id].model === model,
  );
}
