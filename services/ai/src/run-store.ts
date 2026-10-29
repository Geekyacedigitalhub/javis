import {
  FROSH_AGENT_RUN_TIMEOUT_ERROR,
  FROSH_AGENT_RUN_TIMEOUT_RESULT,
  FroshAgentRunConcurrencyError,
  type FroshAgentRun,
  type FroshAgentRunCheckpoint,
  type FroshAgentRunCreateInput,
  type FroshAgentRunEvent,
  type FroshAgentRunStore,
} from "../../../packages/types/src/agent-run";
import type { FroshToolCall } from "../../../packages/types/src/javis";

export class InMemoryAgentRunStore implements FroshAgentRunStore {
  private readonly runs = new Map<string, FroshAgentRun>();
  private readonly events = new Map<string, FroshAgentRunEvent[]>();
  private readonly checkpoints = new Map<string, FroshAgentRunCheckpoint[]>();
  private readonly idempotencyKeys = new Map<string, string>();

  constructor(private readonly maxActiveRuns = 2) {}

  private idempotencyId(userId: string, key: string) {
    return `${userId}\u0000${key}`;
  }

  private eventFor(run: FroshAgentRun, previous?: FroshAgentRun): FroshAgentRunEvent | null {
    if (previous && previous.status === run.status) return null;
    const type = previous ? run.status : (run.status === "queued" ? "queued" : "created");
    const message =
      type === "created" ? (run.status === "queued" ? "Run queued for durable background execution." : "Agent run created.") :
      type === "queued" ? "Run queued for durable background execution." :
      type === "waiting_approval" ? "FROSH is waiting for approval." :
      type === "cancelled" ? "Run cancelled by the user." :
      type === "failed" ? run.error || "Agent run failed." :
      type === "completed" ? "Agent run completed." : "Agent run is running.";
    return {
      id: crypto.randomUUID(), runId: run.id, userId: run.userId, type,
      status: run.status, message, createdAt: run.updatedAt,
    };
  }

  private checkpointFor(run: FroshAgentRun, previous?: FroshAgentRun): FroshAgentRunCheckpoint | null {
    const statusChanged = Boolean(previous && previous.status !== run.status);
    const toolCallsChanged = Boolean(previous && previous.toolCalls.length !== run.toolCalls.length);
    const approvalChanged = Boolean(previous && previous.pendingApprovalId !== run.pendingApprovalId);
    if (previous && !statusChanged && !toolCallsChanged && !approvalChanged) return null;

    const kind = !previous
      ? "created"
      : run.status === "waiting_approval"
        ? "awaiting_approval"
        : previous.status === "waiting_approval" && run.status === "running"
          ? "approval_resumed"
          : run.status === "completed" || run.status === "failed" || run.status === "cancelled"
            ? run.status
            : toolCallsChanged
              ? "tool_evidence"
              : "running";
    const latestTool = toolCallsChanged ? run.toolCalls.at(-1) : undefined;
    const message =
      kind === "created" ? (run.status === "queued" ? "Checkpoint saved while background work is queued." : "Checkpoint created before FROSH began work.")
      : kind === "awaiting_approval" ? "Checkpoint saved while FROSH waits for approval."
      : kind === "approval_resumed" ? "Checkpoint saved after approval; execution resumed."
      : kind === "tool_evidence" && latestTool ? `Checkpoint saved after ${latestTool.name} (${latestTool.status}).`
      : kind === "completed" ? "Checkpoint saved when the run completed."
      : kind === "failed" ? "Checkpoint saved when the run stopped safely."
      : kind === "cancelled" ? "Checkpoint saved when the run was cancelled."
      : "Checkpoint saved while FROSH continued work.";
    return {
      id: crypto.randomUUID(), runId: run.id, userId: run.userId, kind,
      status: run.status, message, toolCallCount: run.toolCalls.length, createdAt: run.updatedAt,
    };
  }

  private save(run: FroshAgentRun, previous?: FroshAgentRun) {
    this.runs.set(run.id, run);
    const event = this.eventFor(run, previous);
    if (event) this.events.set(run.id, [...(this.events.get(run.id) ?? []), event]);
    const checkpoint = this.checkpointFor(run, previous);
    if (checkpoint) this.checkpoints.set(run.id, [...(this.checkpoints.get(run.id) ?? []), checkpoint]);
  }

  private ensureCapacity(userId: string) {
    const active = [...this.runs.values()].filter(
      (run) => run.userId === userId && (run.status === "running" || run.status === "waiting_approval"),
    ).length;
    if (active >= this.maxActiveRuns) throw new FroshAgentRunConcurrencyError(this.maxActiveRuns);
  }

  private createNew(input: FroshAgentRunCreateInput) {
    const userId = input.userId?.trim() || "default-user";
    if (input.status === "running" || input.status === "waiting_approval") this.ensureCapacity(userId);
    const now = new Date().toISOString();
    const run: FroshAgentRun = {
      ...input, mode: input.mode ?? "session", message: input.message?.trim() || input.goal,
      userId, id: crypto.randomUUID(), createdAt: now, updatedAt: now,
    };
    this.save(run);
    return run;
  }

  async create(input: FroshAgentRunCreateInput) {
    return this.createNew(input);
  }

  async createIdempotent(input: FroshAgentRunCreateInput & { idempotencyKey: string }) {
    const userId = input.userId?.trim() || "default-user";
    const key = this.idempotencyId(userId, input.idempotencyKey);
    const existingId = this.idempotencyKeys.get(key);
    if (existingId) {
      const run = this.runs.get(existingId);
      if (run) return { run, created: false };
    }
    const { idempotencyKey: _idempotencyKey, ...runInput } = input;
    const run = this.createNew({ ...runInput, userId });
    this.idempotencyKeys.set(key, run.id);
    return { run, created: true };
  }

  async findByIdempotencyKey(userId: string, idempotencyKey: string) {
    const id = this.idempotencyKeys.get(this.idempotencyId(userId, idempotencyKey));
    return id ? this.runs.get(id) ?? null : null;
  }

  async get(id: string) {
    return this.runs.get(id) ?? null;
  }

  async listEvents(runId: string, userId?: string, limit = 100) {
    const run = this.runs.get(runId);
    if (!run || (userId && run.userId !== userId)) return [];
    const safeLimit = Math.min(200, Math.max(1, Math.trunc(limit)));
    return (this.events.get(runId) ?? []).slice(0, safeLimit);
  }

  async listCheckpoints(runId: string, userId?: string, limit = 100) {
    const run = this.runs.get(runId);
    if (!run || (userId && run.userId !== userId)) return [];
    const safeLimit = Math.min(200, Math.max(1, Math.trunc(limit)));
    return (this.checkpoints.get(runId) ?? []).slice(0, safeLimit);
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
    if (current.status !== "running" && current.status !== "waiting_approval") return current;
    const updated = { ...current, updatedAt: new Date().toISOString() };
    this.save(updated, current);
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
    this.save(updated, current);
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
    this.save(updated, current);
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
    this.save(updated, current);
    return updated;
  }

  async claimQueued(id: string, userId?: string) {
    const current = this.runs.get(id);
    if (!current || current.status !== "queued" || (userId && current.userId !== userId)) return null;
    try {
      this.ensureCapacity(current.userId);
    } catch (error) {
      if (error instanceof FroshAgentRunConcurrencyError) return null;
      throw error;
    }
    const claimed: FroshAgentRun = { ...current, status: "running", updatedAt: new Date().toISOString() };
    this.save(claimed, current);
    return claimed;
  }

  async cancel(id: string, userId?: string) {
    const current = this.runs.get(id);
    if (!current || (userId && current.userId !== userId)) return null;
    if (current.status !== "queued" && current.status !== "running" && current.status !== "waiting_approval") return null;
    const updated: FroshAgentRun = {
      ...current,
      status: "cancelled",
      pendingApprovalId: undefined,
      providerContinuation: undefined,
      result: "Cancelled by the user before FROSH could complete this run.",
      error: undefined,
      updatedAt: new Date().toISOString(),
    };
    this.save(updated, current);
    return updated;
  }

  async timeout(id: string) {
    const current = this.runs.get(id);
    if (!current || current.status !== "running") return null;
    const updated: FroshAgentRun = {
      ...current,
      status: "failed",
      pendingApprovalId: undefined,
      providerContinuation: undefined,
      result: FROSH_AGENT_RUN_TIMEOUT_RESULT,
      error: FROSH_AGENT_RUN_TIMEOUT_ERROR,
      updatedAt: new Date().toISOString(),
    };
    this.save(updated, current);
    return updated;
  }

  async recoverInterrupted(userId?: string) {
    let recovered = 0;
    for (const [id, current] of this.runs) {
      if (current.status !== "running" || (userId && current.userId !== userId)) continue;
      this.save({
        ...current,
        status: "failed",
        providerContinuation: undefined,
        pendingApprovalId: undefined,
        result: "FROSH restarted before this run finished. It was not replayed because a provider or tool action may have already happened; review the evidence and start a new run if needed.",
        error: "Agent process restarted while this run was active",
        updatedAt: new Date().toISOString(),
      }, current);
      recovered += 1;
    }
    return recovered;
  }

  async update(id: string, patch: Partial<Omit<FroshAgentRun, "id" | "createdAt" | "userId">>) {
    const current = this.runs.get(id);
    if (!current) throw new Error("Agent run not found");
    // Terminal state is immutable. Late provider/tool writes must not turn a
    // cancelled, timed-out, completed, or failed run into another outcome.
    if (current.status !== "running" && current.status !== "waiting_approval") return current;
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.save(updated, current);
    return updated;
  }
}
