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
  delete(id: string): Promise<boolean>;
}

export type FroshMemoryKind = "preference" | "commitment" | "relationship" | "project_context" | "important_fact";

export interface FroshMemoryCandidate {
  kind: FroshMemoryKind;
  statement: string;
  confidence: number;
  sourceConversationId?: string;
  sourceMessageId?: string;
}

export interface FroshMemoryExtractionResult {
  candidates: FroshMemoryCandidate[];
  skippedCount: number;
}

export type FroshMemoryCandidateStatus = "pending" | "approved" | "rejected";

export interface FroshMemoryCandidateRecord extends FroshMemoryCandidate {
  id: string;
  status: FroshMemoryCandidateStatus;
  createdAt: string;
  resolvedAt?: string;
}

export interface FroshMemoryControlResult {
  accepted: boolean;
  message: string;
}
