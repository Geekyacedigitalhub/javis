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
