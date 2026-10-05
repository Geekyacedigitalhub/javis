import type { FroshAgentRun, FroshAgentRunStore } from "../../../packages/types/src/agent-run";

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

  async update(id: string, patch: Partial<Omit<FroshAgentRun, "id" | "createdAt">>) {
    const current = this.runs.get(id);
    if (!current) throw new Error("Agent run not found");
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.runs.set(id, updated);
    return updated;
  }
}
