/**
 * Plan tier, as carried by the auth service's JWT `tier` claim. Drives the
 * read meter's daily byte limit: READ_BUDGET_BASE_BYTES x TIER_MULTIPLIER.
 * 'none' (unpaid) reads at the Starter rate.
 */
export type Tier = 'none' | 'starter' | 'individual' | 'professional';

export const TIER_MULTIPLIER: Record<Tier, number> = {
  none: 1,
  starter: 1,
  individual: 5,
  professional: 20,
};

/** A claim value we recognise, else undefined (which meters as 1x). */
export function parseTier(value: unknown): Tier | undefined {
  return typeof value === 'string' && Object.hasOwn(TIER_MULTIPLIER, value)
    ? (value as Tier)
    : undefined;
}
