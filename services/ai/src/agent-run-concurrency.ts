const DEFAULT_AGENT_RUN_MAX_ACTIVE = 2;
const MIN_AGENT_RUN_MAX_ACTIVE = 1;
const MAX_AGENT_RUN_MAX_ACTIVE = 5;

/**
 * Bound simultaneous durable runs per account. This protects constrained
 * provider quotas and avoids several autonomous agents changing one user's
 * workspace at once. The stores apply the same bound atomically.
 */
export function agentRunMaxActiveRuns(override?: number): number {
  const requested = override ?? Number(process.env.FROSH_AGENT_MAX_ACTIVE_RUNS ?? DEFAULT_AGENT_RUN_MAX_ACTIVE);
  if (!Number.isFinite(requested)) return DEFAULT_AGENT_RUN_MAX_ACTIVE;
  return Math.min(MAX_AGENT_RUN_MAX_ACTIVE, Math.max(MIN_AGENT_RUN_MAX_ACTIVE, Math.floor(requested)));
}
