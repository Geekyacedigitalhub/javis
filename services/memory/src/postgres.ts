import postgres from "postgres";
import type { ConversationRecord, MemoryRecord, MemoryStore, MessageRecord } from "./types";

type Sql = ReturnType<typeof postgres>;

export class PostgresMemoryStore implements MemoryStore {
  constructor(private readonly sql: Sql) {}

  private query<T extends object>(text: string, values: unknown[] = []) {
    return this.sql.unsafe<T[]>(text, values);
  }

  async getConversation(id: string) {
    const rows = await this.query<ConversationRecord>(
      'SELECT id, user_id AS "userId", created_at AS "createdAt", updated_at AS "updatedAt" FROM javis_conversations WHERE id = $1 LIMIT 1',
      [id],
    );
    return rows[0] ?? null;
  }

  async createConversation(input: { id?: string; userId?: string } = {}) {
    const id = input.id ?? crypto.randomUUID();
    const rows = await this.query<ConversationRecord>(
      'INSERT INTO javis_conversations (id, user_id) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET user_id = COALESCE(javis_conversations.user_id, EXCLUDED.user_id) RETURNING id, user_id AS "userId", created_at AS "createdAt", updated_at AS "updatedAt"',
      [id, input.userId ?? null],
    );
    return rows[0];
  }

  async listMessages(conversationId: string, limit = 50) {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const rows = await this.query<MessageRecord>(
      'SELECT id, conversation_id AS "conversationId", role, content, created_at AS "createdAt" FROM javis_messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2',
      [conversationId, safeLimit],
    );
    return rows.reverse();
  }

  async appendMessage(input: Omit<MessageRecord, "id" | "createdAt">) {
    const id = crypto.randomUUID();
    const rows = await this.query<MessageRecord>(
      'INSERT INTO javis_messages (id, conversation_id, role, content) VALUES ($1, $2, $3, $4) RETURNING id, conversation_id AS "conversationId", role, content, created_at AS "createdAt"',
      [id, input.conversationId, input.role, input.content],
    );

    await this.query(
      'UPDATE javis_conversations SET updated_at = NOW() WHERE id = $1',
      [input.conversationId],
    );

    return rows[0];
  }

  async listMemories(userId: string, limit = 50) {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    return this.query<MemoryRecord>(
      'SELECT id, user_id AS "userId", kind, content, importance, created_at AS "createdAt", updated_at AS "updatedAt" FROM javis_memories WHERE user_id = $1 ORDER BY importance DESC, updated_at DESC LIMIT $2',
      [userId, safeLimit],
    );
  }

  async saveMemory(input: Omit<MemoryRecord, "id" | "createdAt" | "updatedAt">) {
    const id = crypto.randomUUID();
    const rows = await this.query<MemoryRecord>(
      'INSERT INTO javis_memories (id, user_id, kind, content, importance) VALUES ($1, $2, $3, $4, $5) RETURNING id, user_id AS "userId", kind, content, importance, created_at AS "createdAt", updated_at AS "updatedAt"',
      [id, input.userId, input.kind, input.content, input.importance],
    );
    return rows[0];
  }
}
