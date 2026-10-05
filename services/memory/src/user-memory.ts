import postgres from "postgres";
import type { FroshUserMemory, FroshUserMemoryStore } from "../../../packages/types/src/conversation-memory";

type Sql = ReturnType<typeof postgres>;

export class PostgresUserMemoryStore implements FroshUserMemoryStore {
  constructor(private readonly sql: Sql) {}

  async list(userId: string, limit = 50) {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    return this.sql.unsafe<FroshUserMemory[]>(
      `SELECT id, user_id AS "userId", kind, statement, confidence,
        source_conversation_id AS "sourceConversationId",
        created_at AS "createdAt", updated_at AS "updatedAt"
       FROM frosh_user_memories
       WHERE user_id = $1
       ORDER BY updated_at DESC
       LIMIT $2`,
      [userId, safeLimit]
    );
  }

  async upsert(input: Omit<FroshUserMemory, "id" | "createdAt" | "updatedAt"> & { id?: string }) {
    const id = input.id ?? crypto.randomUUID();
    const rows = await this.sql.unsafe<FroshUserMemory[]>(
      `INSERT INTO frosh_user_memories
        (id, user_id, kind, statement, confidence, source_conversation_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         kind = EXCLUDED.kind,
         statement = EXCLUDED.statement,
         confidence = EXCLUDED.confidence,
         source_conversation_id = EXCLUDED.source_conversation_id,
         updated_at = NOW()
       RETURNING id, user_id AS "userId", kind, statement, confidence,
         source_conversation_id AS "sourceConversationId",
         created_at AS "createdAt", updated_at AS "updatedAt"`,
      [id, input.userId, input.kind, input.statement, input.confidence, input.sourceConversationId ?? null]
    );
    return rows[0];
  }

  async delete(id: string, userId: string) {
    const result = await this.sql.unsafe(
      "DELETE FROM frosh_user_memories WHERE id = $1 AND user_id = $2",
      [id, userId]
    );
    return result.count > 0;
  }
}

export class InMemoryUserMemoryStore implements FroshUserMemoryStore {
  private readonly items = new Map<string, FroshUserMemory>();

  async list(userId: string, limit = 50) {
    return [...this.items.values()]
      .filter((item) => item.userId === userId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, Math.max(1, Math.min(limit, 200)));
  }

  async upsert(input: Omit<FroshUserMemory, "id" | "createdAt" | "updatedAt"> & { id?: string }) {
    const now = new Date().toISOString();
    const value: FroshUserMemory = {
      ...input,
      id: input.id ?? crypto.randomUUID(),
      createdAt: now,
      updatedAt: now
    };
    this.items.set(value.id, value);
    return value;
  }

  async delete(id: string, userId: string) {
    const value = this.items.get(id);
    if (!value || value.userId !== userId) return false;
    this.items.delete(id);
    return true;
  }
}
