import postgres from "postgres";
import type { FroshTask, FroshTaskPriority, FroshTaskStatus, FroshTaskStore } from "../../../packages/types/src/productivity";

type Sql = ReturnType<typeof postgres>;
type TaskInput = Omit<FroshTask, "id" | "createdAt" | "updatedAt" | "completedAt">;
type TaskPatch = Partial<Pick<FroshTask, "title" | "notes" | "dueAt" | "status" | "priority">>;

const MAX_TITLE_CHARS = 300;
const MAX_NOTES_CHARS = 8_000;
const MAX_TASKS_PER_USER = 1_000;
const statuses: FroshTaskStatus[] = ["open", "in_progress", "completed", "cancelled"];
const priorities: FroshTaskPriority[] = ["low", "normal", "high"];
const FIELDS = 'id, user_id AS "userId", title, notes, due_at AS "dueAt", status, priority, created_at AS "createdAt", updated_at AS "updatedAt", completed_at AS "completedAt"';

function cleanText(value: unknown, label: string, maxChars: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${label} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  const text = value.trim();
  if ((required && !text) || text.length > maxChars || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new Error(`${label} is invalid or too long`);
  }
  return text || undefined;
}

function normalizeDueAt(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("dueAt must be a valid date-time");
  return new Date(value).toISOString();
}

function validateInput(input: TaskInput): TaskInput {
  const userId = cleanText(input.userId, "userId", 200, true)!;
  const title = cleanText(input.title, "title", MAX_TITLE_CHARS, true)!;
  const notes = cleanText(input.notes, "notes", MAX_NOTES_CHARS);
  if (!statuses.includes(input.status)) throw new Error("Invalid task status");
  if (!priorities.includes(input.priority)) throw new Error("Invalid task priority");
  return { userId, title, ...(notes ? { notes } : {}), ...(normalizeDueAt(input.dueAt) ? { dueAt: normalizeDueAt(input.dueAt) } : {}), status: input.status, priority: input.priority };
}

function validatePatch(patch: TaskPatch): TaskPatch {
  const next: TaskPatch = {};
  if (Object.hasOwn(patch, "title")) next.title = cleanText(patch.title, "title", MAX_TITLE_CHARS, true)!;
  if (Object.hasOwn(patch, "notes")) next.notes = cleanText(patch.notes, "notes", MAX_NOTES_CHARS);
  if (Object.hasOwn(patch, "dueAt")) next.dueAt = normalizeDueAt(patch.dueAt);
  if (Object.hasOwn(patch, "status")) {
    if (!statuses.includes(patch.status!)) throw new Error("Invalid task status");
    next.status = patch.status;
  }
  if (Object.hasOwn(patch, "priority")) {
    if (!priorities.includes(patch.priority!)) throw new Error("Invalid task priority");
    next.priority = patch.priority;
  }
  return next;
}

export class InMemoryTaskStore implements FroshTaskStore {
  private readonly items = new Map<string, FroshTask>();

  async list(userId: string, options: { status?: FroshTaskStatus; limit?: number } = {}) {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 200));
    return [...this.items.values()]
      .filter((task) => task.userId === userId && (!options.status || task.status === options.status))
      .sort((a, b) => {
        const statusOrder = (task: FroshTask) => task.status === "completed" || task.status === "cancelled" ? 1 : 0;
        return statusOrder(a) - statusOrder(b) || (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999") || b.updatedAt.localeCompare(a.updatedAt);
      })
      .slice(0, limit);
  }

  async get(id: string, userId: string) {
    const task = this.items.get(id);
    return task?.userId === userId ? task : null;
  }

  async create(input: TaskInput) {
    const next = validateInput(input);
    const count = [...this.items.values()].filter((task) => task.userId === next.userId).length;
    if (count >= MAX_TASKS_PER_USER) throw new Error("Task limit reached for this user");
    const now = new Date().toISOString();
    const task: FroshTask = { id: crypto.randomUUID(), ...next, createdAt: now, updatedAt: now };
    if (task.status === "completed") task.completedAt = now;
    this.items.set(task.id, task);
    return task;
  }

  async update(id: string, userId: string, patch: TaskPatch) {
    const current = await this.get(id, userId);
    if (!current) return null;
    const next = { ...current, ...validatePatch(patch), updatedAt: new Date().toISOString() };
    if (patch.status === "completed" && current.status !== "completed") next.completedAt = next.updatedAt;
    if (patch.status && patch.status !== "completed") next.completedAt = undefined;
    this.items.set(id, next);
    return next;
  }

  async delete(id: string, userId: string) {
    if (!(await this.get(id, userId))) return false;
    this.items.delete(id);
    return true;
  }
}

export class PostgresTaskStore implements FroshTaskStore {
  constructor(private readonly sql: Sql) {}

  async close() { await this.sql.end({ timeout: 5 }); }

  async list(userId: string, options: { status?: FroshTaskStatus; limit?: number } = {}) {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 200));
    const rows = await this.sql.unsafe<FroshTask[]>(
      `SELECT ${FIELDS} FROM frosh_tasks WHERE user_id=$1 AND ($2::text IS NULL OR status=$2)
       ORDER BY CASE WHEN status IN ('completed','cancelled') THEN 1 ELSE 0 END, due_at NULLS LAST, updated_at DESC LIMIT $3`,
      [userId, options.status ?? null, limit],
    );
    return rows;
  }

  async get(id: string, userId: string) {
    const rows = await this.sql.unsafe<FroshTask[]>(`SELECT ${FIELDS} FROM frosh_tasks WHERE id=$1 AND user_id=$2 LIMIT 1`, [id, userId]);
    return rows[0] ?? null;
  }

  async create(input: TaskInput) {
    const next = validateInput(input);
    return this.sql.begin(async (sql) => {
      await sql.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [next.userId]);
      const count = await sql.unsafe<{ count: number }[]>("SELECT COUNT(*)::int AS count FROM frosh_tasks WHERE user_id=$1", [next.userId]);
      if ((count[0]?.count ?? 0) >= MAX_TASKS_PER_USER) throw new Error("Task limit reached for this user");
      const id = crypto.randomUUID();
      const rows = await sql.unsafe<FroshTask[]>(
        `INSERT INTO frosh_tasks(id,user_id,title,notes,due_at,status,priority,completed_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $6='completed' THEN NOW() ELSE NULL END) RETURNING ${FIELDS}`,
        [id, next.userId, next.title, next.notes ?? null, next.dueAt ?? null, next.status, next.priority],
      );
      return rows[0];
    });
  }

  async update(id: string, userId: string, patch: TaskPatch) {
    const current = await this.get(id, userId);
    if (!current) return null;
    const next = { ...current, ...validatePatch(patch) };
    const rows = await this.sql.unsafe<FroshTask[]>(
      `UPDATE frosh_tasks SET title=$3,notes=$4,due_at=$5,status=$6,priority=$7,
       completed_at=CASE WHEN $6='completed' AND status<>'completed' THEN NOW() WHEN $6<>'completed' THEN NULL ELSE completed_at END,
       updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING ${FIELDS}`,
      [id, userId, next.title, next.notes ?? null, next.dueAt ?? null, next.status, next.priority],
    );
    return rows[0] ?? null;
  }

  async delete(id: string, userId: string) {
    const result = await this.sql.unsafe("DELETE FROM frosh_tasks WHERE id=$1 AND user_id=$2", [id, userId]);
    return result.count > 0;
  }
}
