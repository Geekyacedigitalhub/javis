import {
  FROSH_AGENT_RUN_TIMEOUT_ERROR,
  FROSH_AGENT_RUN_TIMEOUT_RESULT,
  type FroshAgentRun,
} from "../../../packages/types/src/agent-run";

export const AGENT_RUN_TIMEOUT_ERROR = FROSH_AGENT_RUN_TIMEOUT_ERROR;
export const AGENT_RUN_TIMEOUT_RESULT = FROSH_AGENT_RUN_TIMEOUT_RESULT;

const DEFAULT_AGENT_RUN_TIMEOUT_MS = 10 * 60_000;
const MIN_AGENT_RUN_TIMEOUT_MS = 10;
const MAX_AGENT_RUN_TIMEOUT_MS = 60 * 60_000;

/** Resolve one bounded execution budget for a model invocation. Constructor
 * overrides make the runtime testable; production defaults to ten minutes. */
export function agentRunTimeoutMs(override?: number): number {
  const requested = override ?? Number(process.env.FROSH_AGENT_RUN_TIMEOUT_MS ?? DEFAULT_AGENT_RUN_TIMEOUT_MS);
  if (!Number.isFinite(requested)) return DEFAULT_AGENT_RUN_TIMEOUT_MS;
  return Math.min(MAX_AGENT_RUN_TIMEOUT_MS, Math.max(MIN_AGENT_RUN_TIMEOUT_MS, Math.floor(requested)));
}

export function isAgentRunTimedOut(run: FroshAgentRun | null | undefined): boolean {
  return run?.status === "failed" && run.error === AGENT_RUN_TIMEOUT_ERROR;
}
