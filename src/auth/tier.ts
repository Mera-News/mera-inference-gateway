/**
 * Plan tier, as carried by the auth service's JWT `tier` claim. Picks the read
 * meter's daily byte budget. Budgets are static per tier and set in infra
 * (READ_BUDGET_{STARTER,INDIVIDUAL,PROFESSIONAL}_BYTES); mera-server reads the
 * same three vars, so no copy of the numbers lives in code.
 * 'none' (unpaid) and an unknown tier budget as Starter.
 */
export type Tier = 'none' | 'starter' | 'individual' | 'professional';

const TIERS: ReadonlySet<string> = new Set<Tier>(['none', 'starter', 'individual', 'professional']);

/** A claim value we recognise, else undefined (which budgets as Starter). */
export function parseTier(value: unknown): Tier | undefined {
  return typeof value === 'string' && TIERS.has(value) ? (value as Tier) : undefined;
}
