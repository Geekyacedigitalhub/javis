import type { FroshToolCall } from "./javis";

export type FroshRunStatus = "running" | "waiting_approval" | "completed" | "failed" | "cancelled";

export const FROSH_AGENT_RUN_TIMEOUT_ERROR = "Agent run execution timed out";
export const FROSH_AGENT_RUN_TIMEOUT_RESULT =
  "FROSH stopped this run because its execution time limit expired. It did not replay any provider or tool action; review the recorded evidence before starting another run.";
export const FROSH_AGENT_RUN_CONCURRENCY_ERROR = "FROSH already has the maximum number of active runs for this account.";

/** Raised before model/tool execution when the owner already has its bounded
 * number of active or approval-waiting runs. */
export class FroshAgentRunConcurrencyError extends Error {
  constructor(public readonly limit: number) {
    super(FROSH_AGENT_RUN_CONCURRENCY_ERROR);
    this.name = "FroshAgentRunConcurrencyError";
  }
}

/**
 * A provider continuation is intentionally provider-specific. It contains only
 * the minimal state needed to resume a model after an approval; credentials and
 * provider secrets are never persisted here.
 */
export type FroshProviderContinuation =
  | {
      provider: "openai";
      responseId: string;
      pendingCallId?: string;
      pendingToolName?: string;
      pendingToolOutputs?: Array<{ callId: string; output: string }>;
    }
  | {
      provider: "gemini";
      /** Gemini has no server-side response id, so retain the bounded transcript required to resume a function call. */
      contents: Array<Record<string, unknown>>;
      pendingCallId?: string;
      pendingToolName?: string;
    };

export interface FroshAgentRun {
  id: string;
  /** Server-scoped owner. Agent run records and cancellation are never shared
   * merely because another client can guess an id. */
  userId: string;
  conversationId?: string;
  goal: string;
  status: FroshRunStatus;
  toolCalls: FroshToolCall[];
  pendingApprovalId?: string;
  providerContinuation?: FroshProviderContinuation;
  createdAt: string;
  updatedAt: string;
  result?: string;
  error?: string;
}

export interface FroshAgentRunFilter {
  userId?: string;
  status?: FroshRunStatus | "all";
  limit?: number;
}

export type FroshAgentRunCreateInput = Omit<FroshAgentRun, "id" | "createdAt" | "updatedAt" | "userId"> & {
  userId?: string;
};

export interface FroshIdempotentAgentRunCreation {
  run: FroshAgentRun;
  /** False means a prior request with this owner/key already owns execution. */
  created: boolean;
}

/** Append-only audit record. It intentionally stores status transitions rather
 * than provider prompts or secrets, so the console can explain what happened
 * without exposing hidden model state. */
export interface FroshAgentRunEvent {
  id: string;
  runId: string;
  userId: string;
  type: "created" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";
  status: FroshRunStatus;
  message: string;
  createdAt: string;
}

export interface FroshAgentRunStore {
  // userId is optional at this boundary for legacy/internal callers; stores
  // assign the configured default before persistence. New API work always
  // supplies an authenticated owner explicitly.
  create(input: FroshAgentRunCreateInput): Promise<FroshAgentRun>;
  /** Atomically creates once per owner/key, so a retried POST cannot start a
   * second provider or tool execution. */
  createIdempotent(input: FroshAgentRunCreateInput & { idempotencyKey: string }): Promise<FroshIdempotentAgentRunCreation>;
  findByIdempotencyKey(userId: string, idempotencyKey: string): Promise<FroshAgentRun | null>;
  /** Most recent runs first. Never cached: a run's evidence changes as it works. */
  list(filter?: FroshAgentRunFilter): Promise<FroshAgentRun[]>;
  get(id: string): Promise<FroshAgentRun | null>;
  /** Oldest event first, scoped to the owner when supplied. */
  listEvents(runId: string, userId?: string, limit?: number): Promise<FroshAgentRunEvent[]>;
  /** Atomically marks only a live/waiting run cancelled. */
  cancel(id: string, userId?: string): Promise<FroshAgentRun | null>;
  /** Atomically fails only work that is still actively executing after its
   * execution budget expires. */
  timeout(id: string): Promise<FroshAgentRun | null>;
  /** Reconciles work left in progress by a process restart without replaying
   * unknown tool/provider side effects. Approval-waiting runs remain resumable. */
  recoverInterrupted(userId?: string): Promise<number>;
  update(id: string, patch: Partial<Omit<FroshAgentRun, "id" | "createdAt" | "userId">>): Promise<FroshAgentRun>;
  touch(id: string): Promise<FroshAgentRun>;
  claimApproval(id: string, approvalId: string, toolCall: FroshToolCall): Promise<FroshAgentRun | null>;
  restoreApprovalWait(id: string, approvalId: string, toolCalls: FroshToolCall[]): Promise<FroshAgentRun | null>;
  stopWaitingApproval(id: string, approvalId: string, result: string, error: string): Promise<FroshAgentRun | null>;
}
