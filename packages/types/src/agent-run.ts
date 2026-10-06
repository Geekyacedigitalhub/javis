import type { FroshToolCall } from "./javis";

export type FroshRunStatus = "running" | "waiting_approval" | "completed" | "failed";

export interface FroshProviderContinuation {
  provider: "openai";
  responseId: string;
  pendingCallId?: string;
  pendingToolName?: string;
  pendingToolOutputs?: Array<{ callId: string; output: string }>;
}

export interface FroshAgentRun {
  id: string;
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

export interface FroshAgentRunStore {
  create(input: Omit<FroshAgentRun, "id" | "createdAt" | "updatedAt">): Promise<FroshAgentRun>;
  get(id: string): Promise<FroshAgentRun | null>;
  update(id: string, patch: Partial<Omit<FroshAgentRun, "id" | "createdAt">>): Promise<FroshAgentRun>;
  touch(id: string): Promise<FroshAgentRun>;
  claimApproval(id: string, approvalId: string, toolCall: FroshToolCall): Promise<FroshAgentRun | null>;
  restoreApprovalWait(id: string, approvalId: string, toolCalls: FroshToolCall[]): Promise<FroshAgentRun | null>;
  stopWaitingApproval(id: string, approvalId: string, result: string, error: string): Promise<FroshAgentRun | null>;
}
