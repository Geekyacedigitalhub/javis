import type { FroshAgentRun } from "../../../packages/types/src/agent-run";

/**
 * The persisted provider continuation is server-only replay state. It may hold
 * a bounded model transcript and pending function-call metadata, so agent-run
 * HTTP and SSE consumers must only receive this explicitly public projection.
 */
export type PublicAgentRun = Omit<FroshAgentRun, "providerContinuation">;

export function publicAgentRun(run: FroshAgentRun): PublicAgentRun {
  const { providerContinuation: _providerContinuation, ...publicRun } = run;
  return publicRun;
}
