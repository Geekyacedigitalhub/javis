import { getConversationMemoryStore } from "./conversation-memory-factory";
import { mergeConversationMemory } from "./conversation-memory";
import type {
  FroshMemoryCandidate,
  FroshMemoryCandidateRecord,
  FroshMemoryCandidateStatus
} from "../../../packages/types/src/conversation-memory";

const candidates = new Map<string, FroshMemoryCandidateRecord>();

export function createMemoryCandidate(candidate: FroshMemoryCandidate): FroshMemoryCandidateRecord {
  const record: FroshMemoryCandidateRecord = {
    ...candidate,
    id: crypto.randomUUID(),
    status: "pending",
    createdAt: new Date().toISOString()
  };
  candidates.set(record.id, record);
  return record;
}

export function listMemoryCandidates(status?: FroshMemoryCandidateStatus) {
  return [...candidates.values()].filter((item) => !status || item.status === status);
}

export async function resolveMemoryCandidate(id: string, status: "approved" | "rejected") {
  const candidate = candidates.get(id);
  if (!candidate) throw new Error("Memory candidate not found.");
  let resolved = { ...candidate, status, resolvedAt: new Date().toISOString() };

  if (status === "approved") {
    const conversationId = candidate.sourceConversationId?.trim();
    if (!conversationId) throw new Error("Approved memory candidate is missing its source conversation.");

    const store = getConversationMemoryStore();
    const existing = await store.get(conversationId);
    const memory = mergeConversationMemory(existing, {
      provider: existing?.provider ?? "other",
      participant: existing?.participant ?? "unknown",
      statement: candidate.statement
    });
    await store.upsert(memory);
  }

  candidates.set(id, resolved);
  return resolved;
}
