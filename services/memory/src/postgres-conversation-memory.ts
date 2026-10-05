import postgres from "postgres";
import type { FroshConversationMemory, FroshConversationMemoryStore } from "../../../packages/types/src/conversation-memory";

type Sql = ReturnType<typeof postgres>;

export class PostgresConversationMemoryStore implements FroshConversationMemoryStore {
  constructor(private readonly sql: Sql) {}

  async get(id: string) {
    const rows = await this.sql.unsafe<FroshConversationMemory[]>(
      `SELECT id, provider, participant, summary, key_facts AS "keyFacts",
        last_message_at AS "lastMessageAt", updated_at AS "updatedAt"
       FROM frosh_conversation_memories WHERE id = $1 LIMIT 1`,
      [id]
    );
    return rows[0] ? this.normalize(rows[0]) : null;
  }

  async upsert(input: Omit<FroshConversationMemory, "id" | "updatedAt"> & { id?: string }) {
    const id = input.id ?? crypto.randomUUID();
    const rows = await this.sql.unsafe<FroshConversationMemory[]>(
      `INSERT INTO frosh_conversation_memories
        (id, provider, participant, summary, key_facts, last_message_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (id) DO UPDATE SET
        provider = EXCLUDED.provider,
        participant = EXCLUDED.participant,
        summary = EXCLUDED.summary,
        key_facts = EXCLUDED.key_facts,
        last_message_at = EXCLUDED.last_message_at,
        updated_at = NOW()
       RETURNING id, provider, participant, summary, key_facts AS "keyFacts",
         last_message_at AS "lastMessageAt", updated_at AS "updatedAt"`,
      [id, input.provider, input.participant, input.summary, JSON.stringify(input.keyFacts), input.lastMessageAt ?? null]
    );
    return this.normalize(rows[0]);
  }

  async list(limit = 50) {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const rows = await this.sql.unsafe<FroshConversationMemory[]>(
      `SELECT id, provider, participant, summary, key_facts AS "keyFacts",
        last_message_at AS "lastMessageAt", updated_at AS "updatedAt"
       FROM frosh_conversation_memories ORDER BY updated_at DESC LIMIT $1`,
      [safeLimit]
    );
    return rows.map((row) => this.normalize(row));
  }

  async delete(id: string) {
    const result = await this.sql.unsafe(
      "DELETE FROM frosh_conversation_memories WHERE id = $1",
      [id]
    );
    return result.count > 0;
  }

  private normalize(row: FroshConversationMemory) {
    return {
      ...row,
      keyFacts: Array.isArray(row.keyFacts) ? row.keyFacts : []
    };
  }
}
