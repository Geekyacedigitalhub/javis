import type { FroshAgentRun, FroshAgentRunStore } from "../../../packages/types/src/agent-run";
import type { FroshToolCall } from "../../../packages/types/src/javis";

export class InMemoryAgentRunStore implements FroshAgentRunStore {
  private readonly runs = new Map<string, FroshAgentRun>();

  async create(input: Omit<FroshAgentRun, "id" | "createdAt" | "updatedAt" | "userId"> & { userId?: string }) {
    const now = new Date().toISOString();
    const run: FroshAgentRun = { ...input, userId: input.userId?.trim() || "default-user", id: crypto.randomUUID(), createdAt: now, updatedAt: now };
    this.runs.set(run.id, run);
    return run;
  }

  async get(id: string) {
    return this.runs.get(id) ?? null;
  }

  async list(filter: { userId?: string; status?: FroshAgentRun["status"] | "all"; limit?: number } = {}) {
    const limit = Math.min(200, Math.max(1, Math.trunc(filter.limit ?? 50)));
    return [...this.runs.values()]
      .filter((run) => (!filter.userId || run.userId === filter.userId) && (!filter.status || filter.status === "all" || run.status === filter.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
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

  async cancel(id: string, userId?: string) {
    const current = this.runs.get(id);
    if (!current || (userId && current.userId !== userId)) return null;
    if (current.status !== "running" && current.status !== "waiting_approval") return null;
    const updated: FroshAgentRun = {
      ...current,
      status: "cancelled",
      pendingApprovalId: undefined,
      providerContinuation: undefined,
      result: "Cancelled by the user before FROSH could complete this run.",
      error: undefined,
      updatedAt: new Date().toISOString(),
    };
    this.runs.set(id, updated);
    return updated;
  }

  async recoverInterrupted(userId?: string) {
    let recovered = 0;
    for (const [id, current] of this.runs) {
      if (current.status !== "running" || (userId && current.userId !== userId)) continue;
      this.runs.set(id, {
        ...current,
        status: "failed",
        providerContinuation: undefined,
        pendingApprovalId: undefined,
        result: "FROSH restarted before this run finished. It was not replayed because a provider or tool action may have already happened; review the evidence and start a new run if needed.",
        error: "Agent process restarted while this run was active",
        updatedAt: new Date().toISOString(),
      });
      recovered += 1;
    }
    return recovered;
  }

  async update(id: string, patch: Partial<Omit<FroshAgentRun, "id" | "createdAt" | "userId">>) {
    const current = this.runs.get(id);
    if (!current) throw new Error("Agent run not found");
    // A cancellation is terminal. Late provider/tool writes must not turn a
    // user-stopped run into a completed or failed one.
    if (current.status === "cancelled") return current;
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.runs.set(id, updated);
    return updated;
  }
}
