import postgres from "postgres";
import type { FroshAgentRun, FroshAgentRunStore } from "../../../packages/types/src/agent-run";

type Sql = ReturnType<typeof postgres>;

export class PostgresAgentRunStore implements FroshAgentRunStore {
  constructor(private readonly sql: Sql) {}

  private query<T extends object>(text: string, values: unknown[] = []) {
    return this.sql.unsafe<T[]>(text, values);
  }

  async create(input: Omit<FroshAgentRun, "id" | "createdAt" | "updatedAt">) {
    const id = crypto.randomUUID();
    const rows = await this.query<FroshAgentRun>(
      'INSERT INTO frosh_agent_runs (id, conversation_id, goal, status, tool_calls, pending_approval_id, result, error) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING id, conversation_id AS "conversationId", goal, status, tool_calls AS "toolCalls", pending_approval_id AS "pendingApprovalId", created_at AS "createdAt", updated_at AS "updatedAt", result, error',
      [id, input.conversationId ?? null, input.goal, input.status, JSON.stringify(input.toolCalls), input.pendingApprovalId ?? null, input.result ?? null, input.error ?? null],
    );
    return rows[0];
  }

  async get(id: string) {
    const rows = await this.query<FroshAgentRun>(
      'SELECT id, conversation_id AS "conversationId", goal, status, tool_calls AS "toolCalls", pending_approval_id AS "pendingApprovalId", created_at AS "createdAt", updated_at AS "updatedAt", result, error FROM frosh_agent_runs WHERE id=$1',
      [id],
    );
    return rows[0] ?? null;
  }

  async update(id: string, patch: Partial<Omit<FroshAgentRun, "id" | "createdAt">>) {
    const current = await this.get(id);
    if (!current) throw new Error("Agent run not found");
    const next = { ...current, ...patch };
    const rows = await this.query<FroshAgentRun>(
      'UPDATE frosh_agent_runs SET conversation_id=$2, goal=$3, status=$4, tool_calls=$5::jsonb, pending_approval_id=$6, result=$7, error=$8, updated_at=NOW() WHERE id=$1 RETURNING id, conversation_id AS "conversationId", goal, status, tool_calls AS "toolCalls", pending_approval_id AS "pendingApprovalId", created_at AS "createdAt", updated_at AS "updatedAt", result, error',
      [id, next.conversationId ?? null, next.goal, next.status, JSON.stringify(next.toolCalls), next.pendingApprovalId ?? null, next.result ?? null, next.error ?? null],
    );
    return rows[0];
  }
}
