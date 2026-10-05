import type { FroshConversationMemory, FroshConversationMemoryStore } from "../../../packages/types/src/conversation-memory";

export class InMemoryConversationMemoryStore implements FroshConversationMemoryStore {
  private readonly items = new Map<string, FroshConversationMemory>();

  async get(id: string) {
    return this.items.get(id) ?? null;
  }

  async upsert(input: Omit<FroshConversationMemory, "id" | "updatedAt"> & { id?: string }) {
    const id = input.id ?? crypto.randomUUID();
    const value: FroshConversationMemory = {
      ...input,
      id,
      updatedAt: new Date().toISOString()
    };
    this.items.set(id, value);
    return value;
  }

  async list(limit = 50) {
    return [...this.items.values()]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, limit);
  }
}


export function mergeConversationMemory(
  existing: FroshConversationMemory | null,
  candidate: { provider: string; participant: string; statement: string; lastMessageAt?: string }
): FroshConversationMemory {
  const base = existing ?? {
    id: crypto.randomUUID(),
    provider: candidate.provider,
    participant: candidate.participant,
    summary: "",
    keyFacts: []
  };
  const keyFacts = [...new Set([...base.keyFacts, candidate.statement])].slice(-20);
  const summary = [base.summary, candidate.statement].filter(Boolean).join(" | ").slice(-2000);
  return {
    ...base,
    provider: candidate.provider,
    participant: candidate.participant,
    summary,
    keyFacts,
    lastMessageAt: candidate.lastMessageAt,
    updatedAt: new Date().toISOString()
  };
}


export function removeMemoryFact(memory: FroshConversationMemory, fact: string): FroshConversationMemory {
  const normalized = fact.trim().toLowerCase();
  const keyFacts = memory.keyFacts.filter((item) => item.trim().toLowerCase() !== normalized);
  const summary = memory.summary
    .split(" | ")
    .filter((item) => item.trim().toLowerCase() !== normalized)
    .join(" | ");
  return { ...memory, keyFacts, summary, updatedAt: new Date().toISOString() };
}
