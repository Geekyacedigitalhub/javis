import postgres from "postgres";
import type { FroshNote, FroshNoteCreateInput, FroshNotePatch, FroshNoteStore } from "../../../packages/types/src/note";

type Sql = ReturnType<typeof postgres>;

const MAX_NOTES_PER_USER = 2_000;
const MAX_TITLE_CHARS = 300;
const MAX_CONTENT_CHARS = 50_000;
const MAX_TAGS = 20;
const MAX_TAG_CHARS = 48;
const MAX_TASK_ID_CHARS = 200;
const FIELDS = 'id, user_id AS "userId", title, content, tags, pinned, task_id AS "taskId", created_at AS "createdAt", updated_at AS "updatedAt"';

type ListOptions = { query?: string; tag?: string; pinned?: boolean; limit?: number };

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

function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_TAGS) throw new Error(`tags must contain at most ${MAX_TAGS} text labels`);
  const unique = new Map<string, string>();
  for (const item of value) {
    const tag = cleanText(item, "tag", MAX_TAG_CHARS, true)!;
    const key = tag.toLocaleLowerCase();
    if (!unique.has(key)) unique.set(key, tag);
  }
  return [...unique.values()];
}

function cleanTaskId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return cleanText(value, "taskId", MAX_TASK_ID_CHARS, true);
}

function validateCreate(input: FroshNoteCreateInput): FroshNoteCreateInput {
  if (typeof input.pinned !== "boolean") throw new Error("pinned must be true or false");
  const taskId = cleanTaskId(input.taskId);
  return {
    userId: cleanText(input.userId, "userId", 200, true)!,
    title: cleanText(input.title, "title", MAX_TITLE_CHARS, true)!,
    content: cleanText(input.content, "content", MAX_CONTENT_CHARS, true)!,
    tags: cleanTags(input.tags),
    pinned: input.pinned,
    ...(taskId ? { taskId } : {}),
  };
}

function validatePatch(input: FroshNotePatch): FroshNotePatch {
  const patch: FroshNotePatch = {};
  if (Object.hasOwn(input, "title")) patch.title = cleanText(input.title, "title", MAX_TITLE_CHARS, true)!;
  if (Object.hasOwn(input, "content")) patch.content = cleanText(input.content, "content", MAX_CONTENT_CHARS, true)!;
  if (Object.hasOwn(input, "tags")) patch.tags = cleanTags(input.tags);
  if (Object.hasOwn(input, "pinned")) {
    if (typeof input.pinned !== "boolean") throw new Error("pinned must be true or false");
    patch.pinned = input.pinned;
  }
  if (Object.hasOwn(input, "taskId")) patch.taskId = cleanTaskId(input.taskId);
  return patch;
}

function options(input: ListOptions): Required<Pick<ListOptions, "limit">> & Omit<ListOptions, "limit"> {
  const query = input.query === undefined ? undefined : cleanText(input.query, "query", 200);
  const tag = input.tag === undefined ? undefined : cleanText(input.tag, "tag", MAX_TAG_CHARS);
  return { query, tag, pinned: input.pinned, limit: Math.max(1, Math.min(input.limit ?? 100, 200)) };
}

function normalized(note: FroshNote): FroshNote {
  const { taskId, ...rest } = note;
  return taskId ? { ...rest, taskId } : rest;
}

function contains(note: FroshNote, filter: ReturnType<typeof options>): boolean {
  const search = filter.query?.toLocaleLowerCase();
  if (search && !`${note.title}\n${note.content}`.toLocaleLowerCase().includes(search)) return false;
  if (filter.tag && !note.tags.some((tag) => tag.toLocaleLowerCase() === filter.tag!.toLocaleLowerCase())) return false;
  return filter.pinned === undefined || note.pinned === filter.pinned;
}

export class InMemoryNoteStore implements FroshNoteStore {
  private readonly items = new Map<string, FroshNote>();

  async list(userId: string, input: ListOptions = {}) {
    const filter = options(input);
    return [...this.items.values()]
      .filter((note) => note.userId === userId && contains(note, filter))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, filter.limit);
  }

  async get(id: string, userId: string) {
    const note = this.items.get(id);
    return note?.userId === userId ? note : null;
  }

  async create(input: FroshNoteCreateInput) {
    const next = validateCreate(input);
    const count = [...this.items.values()].filter((note) => note.userId === next.userId).length;
    if (count >= MAX_NOTES_PER_USER) throw new Error("Note limit reached for this user");
    const now = new Date().toISOString();
    const note: FroshNote = { id: crypto.randomUUID(), ...next, createdAt: now, updatedAt: now };
    this.items.set(note.id, note);
    return note;
  }

  async update(id: string, userId: string, input: FroshNotePatch) {
    const current = await this.get(id, userId);
    if (!current) return null;
    const changed = validatePatch(input);
    const next = { ...current, ...changed, updatedAt: new Date().toISOString() };
    if (Object.hasOwn(changed, "taskId") && changed.taskId === undefined) delete next.taskId;
    this.items.set(id, next);
    return next;
  }

  async delete(id: string, userId: string) {
    if (!(await this.get(id, userId))) return false;
    this.items.delete(id);
    return true;
  }
}

export class PostgresNoteStore implements FroshNoteStore {
  constructor(private readonly sql: Sql) {}

  async list(userId: string, input: ListOptions = {}) {
    const filter = options(input);
    const pattern = filter.query ? `%${filter.query.toLocaleLowerCase()}%` : null;
    const tag = filter.tag?.toLocaleLowerCase() ?? null;
    const rows = await this.sql.unsafe<FroshNote[]>(
      `SELECT ${FIELDS} FROM frosh_notes WHERE user_id=$1
       AND ($2::text IS NULL OR LOWER(title) LIKE $2 OR LOWER(content) LIKE $2)
       AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(tags) AS item WHERE LOWER(item)=$3))
       AND ($4::boolean IS NULL OR pinned=$4)
       ORDER BY pinned DESC, updated_at DESC LIMIT $5`,
      [userId, pattern, tag, filter.pinned ?? null, filter.limit],
    );
    return rows.map(normalized);
  }

  async get(id: string, userId: string) {
    const rows = await this.sql.unsafe<FroshNote[]>(`SELECT ${FIELDS} FROM frosh_notes WHERE id=$1 AND user_id=$2 LIMIT 1`, [id, userId]);
    return rows[0] ? normalized(rows[0]) : null;
  }

  async create(input: FroshNoteCreateInput) {
    const next = validateCreate(input);
    return this.sql.begin(async (sql) => {
      await sql.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [next.userId]);
      const count = await sql.unsafe<{ count: number }[]>("SELECT COUNT(*)::int AS count FROM frosh_notes WHERE user_id=$1", [next.userId]);
      if ((count[0]?.count ?? 0) >= MAX_NOTES_PER_USER) throw new Error("Note limit reached for this user");
      const rows = await sql.unsafe<FroshNote[]>(
        `INSERT INTO frosh_notes(id,user_id,title,content,tags,pinned,task_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING ${FIELDS}`,
        [crypto.randomUUID(), next.userId, next.title, next.content, JSON.stringify(next.tags), next.pinned, next.taskId ?? null],
      );
      return normalized(rows[0]);
    });
  }

  async update(id: string, userId: string, input: FroshNotePatch) {
    const current = await this.get(id, userId);
    if (!current) return null;
    const next = { ...current, ...validatePatch(input) };
    const rows = await this.sql.unsafe<FroshNote[]>(
      `UPDATE frosh_notes SET title=$3,content=$4,tags=$5::jsonb,pinned=$6,task_id=$7,updated_at=NOW()
       WHERE id=$1 AND user_id=$2 RETURNING ${FIELDS}`,
      [id, userId, next.title, next.content, JSON.stringify(next.tags), next.pinned, next.taskId ?? null],
    );
    return rows[0] ? normalized(rows[0]) : null;
  }

  async delete(id: string, userId: string) {
    const result = await this.sql.unsafe("DELETE FROM frosh_notes WHERE id=$1 AND user_id=$2", [id, userId]);
    return result.count > 0;
  }
}
