import { PROVIDERS } from '../constants';
import { PROFILES } from './profiles';

/** Fixed text: the probe carries no user data. */
const PROBE_PROMPT = 'Reply with the single word: ok';
const ATTESTATION_TIMEOUT_MS = 15_000;
const COMPLETION_TIMEOUT_MS = 30_000;

/**
 * One health probe: an attestation fetch plus an 8-token completion, both must
 * answer 2xx with a body. The completion is plain (NEAR does not need E2EE for
 * it) and only `choices` is checked, since an 8-token budget can be all reasoning.
 * Never logs a body.
 */
export async function probeProfile(profileId: string, apiKey: string): Promise<boolean> {
  const profile = PROFILES[profileId];
  if (!profile) return false;
  const { baseUrl } = PROVIDERS[profile.provider];
  const auth = { Authorization: `Bearer ${apiKey}` };
  try {
    const [attested, answered] = await Promise.all([
      fetch(`${baseUrl}/attestation/report?model=${encodeURIComponent(profile.model)}`, {
        headers: auth,
        signal: AbortSignal.timeout(ATTESTATION_TIMEOUT_MS),
      }).then(async (r) => r.ok && (await r.text()).length > 0),
      fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: profile.model,
          messages: [{ role: 'user', content: PROBE_PROMPT }],
          max_tokens: 8,
          stream: false,
        }),
        signal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
      }).then(async (r) => {
        if (!r.ok) return false;
        const json = (await r.json()) as { choices?: unknown[] };
        return Array.isArray(json.choices) && json.choices.length > 0;
      }),
    ]);
    return attested && answered;
  } catch {
    return false;
  }
}
