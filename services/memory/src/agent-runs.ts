import postgres from "postgres";
import {
  FROSH_AGENT_RUN_TIMEOUT_ERROR,
  FROSH_AGENT_RUN_TIMEOUT_RESULT,
  FroshAgentRunConcurrencyError,
  type FroshAgentRun,
  type FroshAgentRunCheckpoint,
  type FroshAgentRunCreateInput,
  type FroshAgentRunEvent,
  type FroshAgentRunStore,
} from "../../../packages/types/src/agent-run";

type Sql = ReturnType<typeof postgres>;
type CreateInput = FroshAgentRunCreateInput;

const COLUMNS =
  'id, user_id AS "userId", conversation_id AS "conversationId", goal, COALESCE(input_message, goal) AS "message", mode, status, tool_calls AS "toolCalls", pending_approval_id AS "pendingApprovalId", provider_continuation AS "providerContinuation", created_at AS "createdAt", updated_at AS "updatedAt", result, error';

/** Durable agent-run history. All mutations keep cancellation terminal, so a
 * slow provider cannot turn a user-stopped run into a completed/failed run. */
export class PostgresAgentRunStore implements FroshAgentRunStore {
  constructor(private readonly sql: Sql, private readonly maxActiveRuns = 2) {}

  private query<T extends object>(text: string, values: unknown[] = []) {
    return this.sql.unsafe<T[]>(text, values as never[]);
  }

  private createValues(input: CreateInput, idempotencyKey?: string) {
    return [
      crypto.randomUUID(),
      input.userId?.trim() || "default-user",
      input.conversationId ?? null,
      input.goal,
      input.message?.trim() || input.goal,
      input.mode,
      input.status,
      JSON.stringify(input.toolCalls),
      input.pendingApprovalId ?? null,
      input.providerContinuation ? JSON.stringify(input.providerContinuation) : null,
      input.result ?? null,
      input.error ?? null,
      idempotencyKey ?? null,
    ];
  }

  /** PostgreSQL advisory locks serialize capacity checks per owner without
   * holding a connection for the full model request. The lock lasts only for
   * this INSERT statement's transaction, so two API instances cannot both see
   * the same final slot and start excess work. */
  private async createWithCapacity(input: CreateInput, idempotencyKey?: string) {
    const values = [...this.createValues(input, idempotencyKey), this.maxActiveRuns];
    const conflict = idempotencyKey
      ? "ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING"
      : "";
    const rows = await this.query<FroshAgentRun>(
      `WITH owner_lock AS MATERIALIZED (
         SELECT 1 AS guard FROM (SELECT pg_advisory_xact_lock(hashtext($2::text))) AS acquired
       )
       INSERT INTO frosh_agent_runs (id, user_id, conversation_id, goal, input_message, mode, status, tool_calls, pending_approval_id, provider_continuation, result, error, idempotency_key)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12,$13
       FROM owner_lock
       WHERE $7::text NOT IN ('running', 'waiting_approval')
          OR (SELECT COUNT(*) FROM frosh_agent_runs WHERE user_id=$2 AND status IN ('running', 'waiting_approval') AND owner_lock.guard=1) < $14
       ${conflict}
       RETURNING ${COLUMNS}`,
      values,
    );
    return rows[0] ?? null;
  }

  async create(input: CreateInput) {
    const run = await this.createWithCapacity(input);
    if (!run) throw new FroshAgentRunConcurrencyError(this.maxActiveRuns);
    return run;
  }

  async createIdempotent(input: CreateInput & { idempotencyKey: string }) {
    const created = await this.createWithCapacity(input, input.idempotencyKey);
    if (created) return { run: created, created: true };
    const userId = input.userId?.trim() || "default-user";
    const run = await this.findByIdempotencyKey(userId, input.idempotencyKey);
    if (run) return { run, created: false };
    throw new FroshAgentRunConcurrencyError(this.maxActiveRuns);
  }

  async findByIdempotencyKey(userId: string, idempotencyKey: string) {
    const rows = await this.query<FroshAgentRun>(
      `SELECT ${COLUMNS} FROM frosh_agent_runs WHERE user_id=$1 AND idempotency_key=$2`,
      [userId, idempotencyKey],
    );
    return rows[0] ?? null;
  }

  async get(id: string) {
    const rows = await this.query<FroshAgentRun>(`SELECT ${COLUMNS} FROM frosh_agent_runs WHERE id=$1`, [id]);
    return rows[0] ?? null;
  }

  async list(filter: { userId?: string; status?: FroshAgentRun["status"] | "all"; limit?: number } = {}) {
    const limit = Math.min(200, Math.max(1, Math.trunc(filter.limit ?? 50)));
    const where: string[] = [];
    const values: unknown[] = [];
    const add = (condition: string, value: unknown) => {
      values.push(value);
      where.push(condition.replace("?", `$${values.length}`));
    };
    if (filter.userId) add("user_id=?", filter.userId);
    if (filter.status && filter.status !== "all") add("status=?", filter.status);
    values.push(limit);
    return this.query<FroshAgentRun>(
      `SELECT ${COLUMNS} FROM frosh_agent_runs${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT $${values.length}`,
      values,
    );
  }

  async listEvents(runId: string, userId?: string, limit = 100) {
    const safeLimit = Math.min(200, Math.max(1, Math.trunc(limit)));
    const values: unknown[] = [runId];
    const ownerClause = userId ? (values.push(userId), " AND user_id=$2") : "";
    values.push(safeLimit);
    return this.query<FroshAgentRunEvent>(
      `SELECT id::text AS id, run_id AS "runId", user_id AS "userId", type, status, message, created_at AS "createdAt"
       FROM frosh_agent_run_events WHERE run_id=$1${ownerClause} ORDER BY created_at ASC, id ASC LIMIT $${values.length}`,
      values,
    );
  }

  async listCheckpoints(runId: string, userId?: string, limit = 100) {
    const safeLimit = Math.min(200, Math.max(1, Math.trunc(limit)));
    const values: unknown[] = [runId];
    const ownerClause = userId ? (values.push(userId), " AND user_id=$2") : "";
    values.push(safeLimit);
    return this.query<FroshAgentRunCheckpoint>(
      `SELECT id::text AS id, run_id AS "runId", user_id AS "userId", kind, status, message,
              tool_call_count AS "toolCallCount", created_at AS "createdAt"
       FROM frosh_agent_run_checkpoints WHERE run_id=$1${ownerClause} ORDER BY created_at ASC, id ASC LIMIT $${values.length}`,
      values,
    );
  }

  async claimQueued(id: string, userId?: string) {
    const rows = await this.query<FroshAgentRun>(
      `WITH target AS MATERIALIZED (
         SELECT user_id FROM frosh_agent_runs
         WHERE id=$1 AND ($2::text IS NULL OR user_id=$2) AND status='queued'
       ), owner_lock AS MATERIALIZED (
         SELECT target.user_id, 1 AS guard
         FROM target CROSS JOIN LATERAL (SELECT pg_advisory_xact_lock(hashtext(target.user_id))) AS acquired
       )
       UPDATE frosh_agent_runs AS run
       SET status='running', updated_at=NOW()
       FROM owner_lock
       WHERE run.id=$1 AND run.status='queued'
         AND (SELECT COUNT(*) FROM frosh_agent_runs WHERE user_id=owner_lock.user_id AND status IN ('running', 'waiting_approval') AND owner_lock.guard=1) < $3
       RETURNING ${COLUMNS}`,
      [id, userId ?? null, this.maxActiveRuns],
    );
    return rows[0] ?? null;
  }

  async touch(id: string) {
    const rows = await this.query<FroshAgentRun>(
      `UPDATE frosh_agent_runs SET updated_at=NOW() WHERE id=$1 AND status IN ('running', 'waiting_approval') RETURNING ${COLUMNS}`,
      [id],
    );
    if (rows[0]) return rows[0];
    const current = await this.get(id);
    if (current && current.status !== "running" && current.status !== "waiting_approval") return current;
    throw new Error("Agent run not found");
  }

  async claimApproval(id: string, approvalId: string, toolCall: import("../../../packages/types/src/javis").FroshToolCall) {
    const rows = await this.query<FroshAgentRun>(
      `UPDATE frosh_agent_runs SET status=$3, pending_approval_id=NULL, tool_calls=tool_calls || $4::jsonb, updated_at=NOW()
       WHERE id=$1 AND status=$2 AND pending_approval_id=$5 RETURNING ${COLUMNS}`,
      [id, "waiting_approval", "running", JSON.stringify([toolCall]), approvalId],
    );
    return rows[0] ?? null;
  }

  async restoreApprovalWait(id: string, approvalId: string, toolCalls: import("../../../packages/types/src/javis").FroshToolCall[]) {
    const rows = await this.query<FroshAgentRun>(
      `UPDATE frosh_agent_runs SET status=$2, pending_approval_id=$3, tool_calls=$4::jsonb, updated_at=NOW()
       WHERE id=$1 AND status=$5 AND pending_approval_id IS NULL RETURNING ${COLUMNS}`,
      [id, "waiting_approval", approvalId, JSON.stringify(toolCalls), "running"],
    );
    return rows[0] ?? null;
  }

  async stopWaitingApproval(id: string, approvalId: string, result: string, error: string) {
    const rows = await this.query<FroshAgentRun>(
      `UPDATE frosh_agent_runs SET status=$3, pending_approval_id=NULL, provider_continuation=NULL, result=$4, error=$5, updated_at=NOW()
       WHERE id=$1 AND status=$2 AND pending_approval_id=$6 RETURNING ${COLUMNS}`,
      [id, "waiting_approval", "failed", result, error, approvalId],
    );
    return rows[0] ?? null;
  }

  async cancel(id: string, userId?: string) {
    const values: unknown[] = [id];
    const ownerClause = userId ? (values.push(userId), " AND user_id=$2") : "";
    const rows = await this.query<FroshAgentRun>(
      `UPDATE frosh_agent_runs
       SET status='cancelled', pending_approval_id=NULL, provider_continuation=NULL,
           result='Cancelled by the user before FROSH could complete this run.', error=NULL, updated_at=NOW()
       WHERE id=$1${ownerClause} AND status IN ('queued', 'running', 'waiting_approval') RETURNING ${COLUMNS}`,
      values,
    );
    return rows[0] ?? null;
  }

  async timeout(id: string) {
    const rows = await this.query<FroshAgentRun>(
      `UPDATE frosh_agent_runs
       SET status='failed', pending_approval_id=NULL, provider_continuation=NULL,
           result=$2, error=$3, updated_at=NOW()
       WHERE id=$1 AND status='running' RETURNING ${COLUMNS}`,
      [id, FROSH_AGENT_RUN_TIMEOUT_RESULT, FROSH_AGENT_RUN_TIMEOUT_ERROR],
    );
    return rows[0] ?? null;
  }

  async recoverInterrupted(userId?: string) {
    const values: unknown[] = [];
    const ownerClause = userId ? (values.push(userId), " AND user_id=$1") : "";
    const rows = await this.query<{ id: string }>(
      `UPDATE frosh_agent_runs
       SET status='failed', pending_approval_id=NULL, provider_continuation=NULL,
           result='FROSH restarted before this run finished. It was not replayed because a provider or tool action may have already happened; review the evidence and start a new run if needed.',
           error='Agent process restarted while this run was active', updated_at=NOW()
       WHERE status='running'${ownerClause} RETURNING id`,
      values,
    );
    return rows.length;
  }

  async update(id: string, patch: Partial<Omit<FroshAgentRun, "id" | "createdAt" | "userId">>) {
    const fields: string[] = [];
    const values: unknown[] = [id];
    const add = (column: string, value: unknown, json = false) => {
      fields.push(`${column}=$${values.length + 1}${json ? "::jsonb" : ""}`);
      values.push(json && value !== null ? JSON.stringify(value) : value);
    };
    if (Object.prototype.hasOwnProperty.call(patch, "conversationId")) add("conversation_id", patch.conversationId ?? null);
    if (Object.prototype.hasOwnProperty.call(patch, "goal")) add("goal", patch.goal);
    if (Object.prototype.hasOwnProperty.call(patch, "status")) add("status", patch.status);
    if (Object.prototype.hasOwnProperty.call(patch, "toolCalls")) add("tool_calls", patch.toolCalls, true);
    if (Object.prototype.hasOwnProperty.call(patch, "pendingApprovalId")) add("pending_approval_id", patch.pendingApprovalId ?? null);
    if (Object.prototype.hasOwnProperty.call(patch, "providerContinuation")) add("provider_continuation", patch.providerContinuation ?? null, true);
    if (Object.prototype.hasOwnProperty.call(patch, "result")) add("result", patch.result ?? null);
    if (Object.prototype.hasOwnProperty.call(patch, "error")) add("error", patch.error ?? null);

    const rows = fields.length
      ? await this.query<FroshAgentRun>(
          `UPDATE frosh_agent_runs SET ${fields.join(", ")}, updated_at=NOW() WHERE id=$1 AND status IN ('running', 'waiting_approval') RETURNING ${COLUMNS}`,
          values,
        )
      : await this.query<FroshAgentRun>(
          `UPDATE frosh_agent_runs SET updated_at=NOW() WHERE id=$1 AND status IN ('running', 'waiting_approval') RETURNING ${COLUMNS}`,
          [id],
        );
    if (rows[0]) return rows[0];
    const current = await this.get(id);
    if (current && current.status !== "running" && current.status !== "waiting_approval") return current;
    throw new Error("Agent run not found");
  }
}
