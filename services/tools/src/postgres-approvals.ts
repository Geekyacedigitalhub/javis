import postgres from "postgres";
import type {
  FroshApprovalListFilter,
  FroshApprovalRequest,
  FroshApprovalStore,
} from "../../../packages/types/src/approval";

const COLUMNS = 'id, run_id AS "runId", tool_name AS "toolName", arguments, reason, status, created_at AS "createdAt", expires_at AS "expiresAt", resolved_at AS "resolvedAt"';

function takeLimit(filter: FroshApprovalListFilter | undefined) {
  const requested = filter?.limit ?? 50;
  return Number.isFinite(requested) ? Math.min(200, Math.max(1, Math.trunc(requested))) : 50;
}

type Sql = ReturnType<typeof postgres>;

export class PostgresApprovalStore implements FroshApprovalStore {
  constructor(private readonly sql: Sql) {}

  private query<T extends object>(text: string, values: unknown[] = []) {
    return this.sql.unsafe<T[]>(text, values as never[]);
  }

  private normalize(row: any): FroshApprovalRequest {
    return {
      id: row.id,
      runId: row.runId ?? undefined,
      toolName: row.toolName,
      arguments: typeof row.arguments === "string" ? JSON.parse(row.arguments) : row.arguments,
      reason: row.reason,
      status: row.status,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
      expiresAt: row.expiresAt instanceof Date ? row.expiresAt.toISOString() : row.expiresAt,
      resolvedAt: row.resolvedAt
        ? row.resolvedAt instanceof Date ? row.resolvedAt.toISOString() : row.resolvedAt
        : undefined,
    };
  }

  async create(input: Omit<FroshApprovalRequest, "id" | "createdAt" | "status">) {
    const id = crypto.randomUUID();
    const rows = await this.query(
      'INSERT INTO frosh_approvals (id, run_id, tool_name, arguments, reason, status, expires_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7) RETURNING id, run_id AS "runId", tool_name AS "toolName", arguments, reason, status, created_at AS "createdAt", expires_at AS "expiresAt", resolved_at AS "resolvedAt"',
      [id, input.runId ?? null, input.toolName, JSON.stringify(input.arguments), input.reason, "pending", input.expiresAt],
    );
    return this.normalize(rows[0]);
  }

  async get(id: string) {
    const rows = await this.query(
      'SELECT id, run_id AS "runId", tool_name AS "toolName", arguments, reason, status, created_at AS "createdAt", expires_at AS "expiresAt", resolved_at AS "resolvedAt" FROM frosh_approvals WHERE id=$1',
      [id],
    );
    if (!rows[0]) return null;
    const record = this.normalize(rows[0]);

    if (record.status === "pending" && Date.now() >= Date.parse(record.expiresAt)) {
      const expired = await this.query(
        'UPDATE frosh_approvals SET status=$2, resolved_at=NOW() WHERE id=$1 AND status=$3 AND expires_at<=NOW() RETURNING id, run_id AS "runId", tool_name AS "toolName", arguments, reason, status, created_at AS "createdAt", expires_at AS "expiresAt", resolved_at AS "resolvedAt"',
        [id, "expired", "pending"],
      );
      return expired[0] ? this.normalize(expired[0]) : record;
    }

    return record;
  }

  async findPendingByRun(runId: string, toolName: string, argumentsHash: string) {
    const rows = await this.query(
      'SELECT id, run_id AS "runId", tool_name AS "toolName", arguments, reason, status, created_at AS "createdAt", expires_at AS "expiresAt", resolved_at AS "resolvedAt" FROM frosh_approvals WHERE run_id=$1 AND tool_name=$2 AND status=$3 AND arguments=$4::jsonb AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1',
      [runId, toolName, "pending", argumentsHash],
    );
    return rows[0] ? this.normalize(rows[0]) : null;
  }

  async list(filter: FroshApprovalListFilter = {}) {
    const limit = takeLimit(filter);

    // Sweep expired requests once per call so the statuses the caller sees are
    // never stale, then read the window it asked for.
    await this.query(
      "UPDATE frosh_approvals SET status=$1, resolved_at=NOW() WHERE status=$2 AND expires_at<=NOW()",
      ["expired", "pending"],
    );

    const wanted = filter.status ?? "all";
    const rows = wanted === "all"
      ? await this.query(`SELECT ${COLUMNS} FROM frosh_approvals ORDER BY created_at DESC LIMIT $1`, [limit])
      : await this.query(`SELECT ${COLUMNS} FROM frosh_approvals WHERE status=$1 ORDER BY created_at DESC LIMIT $2`, [wanted, limit]);

    return rows.map((row) => this.normalize(row));
  }

  async resolve(id: string, status: "approved" | "rejected") {
    const current = await this.get(id);
    if (!current) throw new Error("Approval request not found");
    if (current.status !== "pending") {
      throw new Error(`Approval request is already ${current.status}`);
    }

    const rows = await this.query(
      'UPDATE frosh_approvals SET status=$2, resolved_at=NOW() WHERE id=$1 AND status=$3 AND expires_at>NOW() RETURNING id, run_id AS "runId", tool_name AS "toolName", arguments, reason, status, created_at AS "createdAt", expires_at AS "expiresAt", resolved_at AS "resolvedAt"',
      [id, status, "pending"],
    );
    if (!rows[0]) throw new Error("Approval could not be resolved");
    return this.normalize(rows[0]);
  }
}
