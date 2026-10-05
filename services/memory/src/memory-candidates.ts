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

export function resolveMemoryCandidate(id: string, status: "approved" | "rejected") {
  const candidate = candidates.get(id);
  if (!candidate) throw new Error("Memory candidate not found.");
  const resolved = { ...candidate, status, resolvedAt: new Date().toISOString() };
  candidates.set(id, resolved);
  return resolved;
}
