import type { FroshMessagingProvider } from "./messaging";

export interface FroshConversationMemory {
  id: string;
  provider: FroshMessagingProvider | string;
  participant: string;
  summary: string;
  keyFacts: string[];
  lastMessageAt?: string;
  updatedAt: string;
}

export interface FroshConversationMemoryStore {
  get(id: string): Promise<FroshConversationMemory | null>;
  upsert(input: Omit<FroshConversationMemory, "id" | "updatedAt"> & { id?: string }): Promise<FroshConversationMemory>;
  list(limit?: number): Promise<FroshConversationMemory[]>;
}
