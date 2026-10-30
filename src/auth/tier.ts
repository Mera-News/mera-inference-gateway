/**
 * Plan tier, as carried by the auth service's JWT `tier` claim. Drives the
 * read meter's daily byte limit: READ_BUDGET_BASE_BYTES x TIER_MULTIPLIER.
 * The base IS Starter's budget, so Starter stays 1x: a capability follow-up
 * offers 1x, and anything below a paid tier must not exceed it.
 * 'none' (unpaid) reads at the Starter rate. mera-server keeps a copy
 * (READING_MULTIPLIER); move them together.
 */
export type Tier = 'none' | 'starter' | 'individual' | 'professional';

export const TIER_MULTIPLIER: Record<Tier, number> = {
  none: 1,
  starter: 1,
  individual: 25,
  professional: 100,
};

/** A claim value we recognise, else undefined (which meters as 1x). */
export function parseTier(value: unknown): Tier | undefined {
  return typeof value === 'string' && Object.hasOwn(TIER_MULTIPLIER, value)
    ? (value as Tier)
    : undefined;
}
