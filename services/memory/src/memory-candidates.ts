import postgres from "postgres";
import type {
  FroshMemoryCandidate,
  FroshMemoryCandidateRecord,
  FroshMemoryCandidateStatus
} from "../../../packages/types/src/conversation-memory";
import { getConversationMemoryStore } from "./conversation-memory-factory";
import { mergeConversationMemory } from "./conversation-memory";
import { getUserMemoryStore } from "./user-memory-factory";

type Sql = ReturnType<typeof postgres>;

const memoryStore = new Map<string, FroshMemoryCandidateRecord>();

function sqlClient(): Sql | null {
  const url = process.env.DATABASE_URL?.trim();
  return url ? postgres(url, { max: 5, idle_timeout: 20 }) : null;
}

function normalize(row: any): FroshMemoryCandidateRecord {
  return {
    id: row.id,
    kind: row.kind,
    statement: row.statement,
    confidence: Number(row.confidence),
    sourceConversationId: row.sourceConversationId ?? undefined,
    sourceMessageId: row.sourceMessageId ?? undefined,
    status: row.status,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? undefined,
    userId: row.userId ?? undefined
  };
}

export async function createMemoryCandidate(candidate: FroshMemoryCandidate): Promise<FroshMemoryCandidateRecord> {
  const id = crypto.randomUUID();
  const record: FroshMemoryCandidateRecord = {
    ...candidate,
    id,
    status: "pending",
    createdAt: new Date().toISOString()
  };

  const sql = sqlClient();
  if (!sql) {
    memoryStore.set(id, record);
    return record;
  }

  const rows = await sql.unsafe<any[]>(
    `INSERT INTO frosh_memory_candidates
      (id, kind, statement, confidence, source_conversation_id, source_message_id, user_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
     RETURNING id, kind, statement, confidence,
       source_conversation_id AS "sourceConversationId",
       source_message_id AS "sourceMessageId",
       status, created_at AS "createdAt", resolved_at AS "resolvedAt"`,
    [id, candidate.kind, candidate.statement, candidate.confidence, candidate.sourceConversationId ?? null, candidate.sourceMessageId ?? null, candidate.userId ?? null]
  );
  await sql.end({ timeout: 1 });
  return normalize(rows[0]);
}

export async function listMemoryCandidates(status?: FroshMemoryCandidateStatus): Promise<FroshMemoryCandidateRecord[]> {
  const sql = sqlClient();
  if (!sql) return [...memoryStore.values()].filter((item) => !status || item.status === status);

  const rows = await sql.unsafe<any[]>(
    `SELECT id, kind, statement, confidence,
      source_conversation_id AS "sourceConversationId",
      source_message_id AS "sourceMessageId", user_id AS "userId",
      status, created_at AS "createdAt", resolved_at AS "resolvedAt"
     FROM frosh_memory_candidates
     ${status ? "WHERE status = $1" : ""}
     ORDER BY created_at DESC LIMIT 200`,
    status ? [status] : []
  );
  await sql.end({ timeout: 1 });
  return rows.map(normalize);
}

export async function resolveMemoryCandidate(id: string, status: "approved" | "rejected") {
  const sql = sqlClient();
  let candidate: FroshMemoryCandidateRecord | undefined;

  if (sql) {
    const rows = await sql.unsafe<any[]>(
      `UPDATE frosh_memory_candidates
       SET status = $2, resolved_at = NOW()
       WHERE id = $1
       RETURNING id, kind, statement, confidence,
         source_conversation_id AS "sourceConversationId",
         source_message_id AS "sourceMessageId", user_id AS "userId",
         status, created_at AS "createdAt", resolved_at AS "resolvedAt"`,
      [id, status]
    );
    await sql.end({ timeout: 1 });
    candidate = rows[0] ? normalize(rows[0]) : undefined;
  } else {
    candidate = memoryStore.get(id);
    if (candidate) {
      candidate = { ...candidate, status, resolvedAt: new Date().toISOString() };
      memoryStore.set(id, candidate);
    }
  }

  if (!candidate) throw new Error("Memory candidate not found.");

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

    const userId = candidate.userId?.trim() ?? "";
    if (userId) {
      await getUserMemoryStore().upsert({
        userId,
        kind: candidate.kind,
        statement: candidate.statement,
        confidence: candidate.confidence,
        sourceConversationId: conversationId
      });
    }
  }

  return candidate;
}
