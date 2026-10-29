import type { FroshToolCall } from "./javis";

export type FroshRunStatus = "running" | "waiting_approval" | "completed" | "failed" | "cancelled";

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

export interface FroshAgentRunStore {
  // userId is optional at this boundary for legacy/internal callers; stores
  // assign the configured default before persistence. New API work always
  // supplies an authenticated owner explicitly.
  create(input: Omit<FroshAgentRun, "id" | "createdAt" | "updatedAt" | "userId"> & { userId?: string }): Promise<FroshAgentRun>;
  /** Most recent runs first. Never cached: a run's evidence changes as it works. */
  list(filter?: FroshAgentRunFilter): Promise<FroshAgentRun[]>;
  get(id: string): Promise<FroshAgentRun | null>;
  /** Atomically marks only a live/waiting run cancelled. */
  cancel(id: string, userId?: string): Promise<FroshAgentRun | null>;
  /** Reconciles work left in progress by a process restart without replaying
   * unknown tool/provider side effects. Approval-waiting runs remain resumable. */
  recoverInterrupted(userId?: string): Promise<number>;
  update(id: string, patch: Partial<Omit<FroshAgentRun, "id" | "createdAt" | "userId">>): Promise<FroshAgentRun>;
  touch(id: string): Promise<FroshAgentRun>;
  claimApproval(id: string, approvalId: string, toolCall: FroshToolCall): Promise<FroshAgentRun | null>;
  restoreApprovalWait(id: string, approvalId: string, toolCalls: FroshToolCall[]): Promise<FroshAgentRun | null>;
  stopWaitingApproval(id: string, approvalId: string, result: string, error: string): Promise<FroshAgentRun | null>;
}
