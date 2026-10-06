import type { FroshAgentRun, FroshAgentRunStore } from "../../../packages/types/src/agent-run";
import type { FroshToolCall } from "../../../packages/types/src/javis";

export class InMemoryAgentRunStore implements FroshAgentRunStore {
  private readonly runs = new Map<string, FroshAgentRun>();

  async create(input: Omit<FroshAgentRun, "id" | "createdAt" | "updatedAt">) {
    const now = new Date().toISOString();
    const run: FroshAgentRun = { ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
    this.runs.set(run.id, run);
    return run;
  }

  async get(id: string) {
    return this.runs.get(id) ?? null;
  }

  async touch(id: string) {
    const current = this.runs.get(id);
    if (!current) throw new Error("Agent run not found");
    const updated = { ...current, updatedAt: new Date().toISOString() };
    this.runs.set(id, updated);
    return updated;
  }

  async claimApproval(id: string, approvalId: string, toolCall: FroshToolCall) {
    const current = this.runs.get(id);
    if (!current || current.status !== "waiting_approval" || current.pendingApprovalId !== approvalId) return null;
    const updated: FroshAgentRun = {
      ...current,
      status: "running",
      pendingApprovalId: undefined,
      toolCalls: [...current.toolCalls, toolCall],
      updatedAt: new Date().toISOString(),
    };
    this.runs.set(id, updated);
    return updated;
  }

  async restoreApprovalWait(id: string, approvalId: string, toolCalls: FroshToolCall[]) {
    const current = this.runs.get(id);
    if (!current || current.status !== "running" || current.pendingApprovalId) return null;
    const updated: FroshAgentRun = {
      ...current,
      status: "waiting_approval",
      pendingApprovalId: approvalId,
      toolCalls,
      updatedAt: new Date().toISOString(),
    };
    this.runs.set(id, updated);
    return updated;
  }

  async stopWaitingApproval(id: string, approvalId: string, result: string, error: string) {
    const current = this.runs.get(id);
    if (!current || current.status !== "waiting_approval" || current.pendingApprovalId !== approvalId) return null;
    const updated: FroshAgentRun = {
      ...current,
      status: "failed",
      pendingApprovalId: undefined,
      providerContinuation: undefined,
      result,
      error,
      updatedAt: new Date().toISOString(),
    };
    this.runs.set(id, updated);
    return updated;
  }

  async update(id: string, patch: Partial<Omit<FroshAgentRun, "id" | "createdAt">>) {
    const current = this.runs.get(id);
    if (!current) throw new Error("Agent run not found");
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.runs.set(id, updated);
    return updated;
  }
}
