export interface ConversationRecord {
  id: string;
  userId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: string;
}

export interface MemoryRecord {
  id: string;
  userId: string;
  kind: "preference" | "fact" | "project" | "task";
  content: string;
  importance: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryStore {
  getConversation(id: string): Promise<ConversationRecord | null>;
  createConversation(input?: { id?: string; userId?: string }): Promise<ConversationRecord>;
  listMessages(conversationId: string, limit?: number): Promise<MessageRecord[]>;
  appendMessage(input: Omit<MessageRecord, "id" | "createdAt">): Promise<MessageRecord>;
  listMemories(userId: string, limit?: number): Promise<MemoryRecord[]>;
  saveMemory(input: Omit<MemoryRecord, "id" | "createdAt" | "updatedAt">): Promise<MemoryRecord>;
}
