import type {
  ConversationRecord,
  MemoryRecord,
  MemoryStore,
  MessageRecord,
} from "./types";

export class InMemoryStore implements MemoryStore {
  private conversations = new Map<string, ConversationRecord>();
  private messages: MessageRecord[] = [];
  private memories: MemoryRecord[] = [];

  async getConversation(id: string) {
    return this.conversations.get(id) ?? null;
  }

  async createConversation(input: { id?: string; userId?: string } = {}) {
    const now = new Date().toISOString();
    const record: ConversationRecord = {
      id: input.id ?? crypto.randomUUID(),
      userId: input.userId,
      createdAt: now,
      updatedAt: now,
    };

    this.conversations.set(record.id, record);
    return record;
  }

  async listMessages(conversationId: string, limit = 50) {
    return this.messages
      .filter((message) => message.conversationId === conversationId)
      .slice(-limit);
  }

  async appendMessage(input: Omit<MessageRecord, "id" | "createdAt">) {
    const record: MessageRecord = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };

    this.messages.push(record);
    return record;
  }

  async listMemories(userId: string, limit = 50) {
    return this.memories
      .filter((memory) => memory.userId === userId)
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit);
  }

  async saveMemory(input: Omit<MemoryRecord, "id" | "createdAt" | "updatedAt">) {
    const now = new Date().toISOString();
    const record: MemoryRecord = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };

    this.memories.push(record);
    return record;
  }
}
