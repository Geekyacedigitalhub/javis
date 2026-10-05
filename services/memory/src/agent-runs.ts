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
      'INSERT INTO frosh_agent_runs (id, conversation_id, goal, status, tool_calls, pending_approval_id, result, error) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING id, conversation_id AS "conversationId", goal, status, tool_calls AS "toolCalls", pending_approval_id AS "pendingApprovalId", provider_continuation AS "providerContinuation", created_at AS "createdAt", updated_at AS "updatedAt", result, error',
      [id, input.conversationId ?? null, input.goal, input.status, JSON.stringify(input.toolCalls), input.pendingApprovalId ?? null, input.result ?? null, input.error ?? null],
    );
    return rows[0];
  }

  async get(id: string) {
    const rows = await this.query<FroshAgentRun>(
      'SELECT id, conversation_id AS "conversationId", goal, status, tool_calls AS "toolCalls", pending_approval_id AS "pendingApprovalId", provider_continuation AS "providerContinuation", created_at AS "createdAt", updated_at AS "updatedAt", result, error FROM frosh_agent_runs WHERE id=$1',
      [id],
    );
    return rows[0] ?? null;
  }

  async touch(id: string) {
    const rows = await this.query<FroshAgentRun>(
      'UPDATE frosh_agent_runs SET updated_at=NOW() WHERE id=$1 RETURNING id, conversation_id AS "conversationId", goal, status, tool_calls AS "toolCalls", pending_approval_id AS "pendingApprovalId", provider_continuation AS "providerContinuation", created_at AS "createdAt", updated_at AS "updatedAt", result, error',
      [id],
    );
    if (!rows[0]) throw new Error("Agent run not found");
    return rows[0];
  }

  async update(id: string, patch: Partial<Omit<FroshAgentRun, "id" | "createdAt">>) {
    const fields: string[] = [];
    const values: unknown[] = [id];
    const add = (column: string, value: unknown, transform?: (value: unknown) => unknown) => {
      fields.push(column + "=$" + String(values.length + 1));
      values.push(transform ? transform(value) : value);
    };
    if (Object.prototype.hasOwnProperty.call(patch, "conversationId")) add("conversation_id", patch.conversationId ?? null);
    if (Object.prototype.hasOwnProperty.call(patch, "goal")) add("goal", patch.goal);
    if (Object.prototype.hasOwnProperty.call(patch, "status")) add("status", patch.status);
    if (Object.prototype.hasOwnProperty.call(patch, "toolCalls")) add("tool_calls", JSON.stringify(patch.toolCalls));
    if (Object.prototype.hasOwnProperty.call(patch, "pendingApprovalId")) add("pending_approval_id", patch.pendingApprovalId ?? null);
    if (Object.prototype.hasOwnProperty.call(patch, "providerContinuation")) add("provider_continuation", JSON.stringify(patch.providerContinuation));
    if (Object.prototype.hasOwnProperty.call(patch, "result")) add("result", patch.result ?? null);
    if (Object.prototype.hasOwnProperty.call(patch, "error")) add("error", patch.error ?? null);
    const rows = fields.length
      ? await this.query<FroshAgentRun>(
          'UPDATE frosh_agent_runs SET ' + fields.map((field) => field.startsWith("tool_calls=") ? field + "::jsonb" : field.startsWith("provider_continuation=") ? field + "::jsonb" : field).join(", ") + ', updated_at=NOW() WHERE id=$1 RETURNING id, conversation_id AS "conversationId", goal, status, tool_calls AS "toolCalls", pending_approval_id AS "pendingApprovalId", provider_continuation AS "providerContinuation", created_at AS "createdAt", updated_at AS "updatedAt", result, error',
          values,
        )
      : await this.query<FroshAgentRun>(
          'UPDATE frosh_agent_runs SET updated_at=NOW() WHERE id=$1 RETURNING id, conversation_id AS "conversationId", goal, status, tool_calls AS "toolCalls", pending_approval_id AS "pendingApprovalId", provider_continuation AS "providerContinuation", created_at AS "createdAt", updated_at AS "updatedAt", result, error',
          [id],
        );
    if (!rows[0]) throw new Error("Agent run not found");
    return rows[0];
  }
}
