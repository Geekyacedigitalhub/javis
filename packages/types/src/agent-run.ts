import type { FroshToolCall } from "./javis";

export type FroshRunStatus = "running" | "waiting_approval" | "completed" | "failed";

export interface FroshAgentRun {
  id: string;
  conversationId?: string;
  goal: string;
  status: FroshRunStatus;
  toolCalls: FroshToolCall[];
  pendingApprovalId?: string;
  createdAt: string;
  updatedAt: string;
  result?: string;
  error?: string;
}

export interface FroshAgentRunStore {
  create(input: Omit<FroshAgentRun, "id" | "createdAt" | "updatedAt">): Promise<FroshAgentRun>;
  get(id: string): Promise<FroshAgentRun | null>;
  update(id: string, patch: Partial<Omit<FroshAgentRun, "id" | "createdAt">>): Promise<FroshAgentRun>;
}
