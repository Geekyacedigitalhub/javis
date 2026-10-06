import postgres from "postgres";
import type { FroshApprovalRequest, FroshApprovalStore } from "../../../packages/types/src/approval";

type Sql = ReturnType<typeof postgres>;

export class PostgresApprovalStore implements FroshApprovalStore {
  constructor(private readonly sql: Sql) {}

  private query<T extends object>(text: string, values: unknown[] = []) {
    return this.sql.unsafe<T[]>(text, values);
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
