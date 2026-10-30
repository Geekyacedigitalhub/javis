import postgres from "postgres";
import { validateResearchUrl } from "../../research/src/fetch";
import type {
  FroshHttpMonitor,
  FroshHttpMonitorCheck,
  FroshHttpMonitorCreateInput,
  FroshHttpMonitorPatch,
  FroshMonitorEvent,
  FroshMonitorStore,
} from "../../../packages/types/src/monitoring";

type Sql = ReturnType<typeof postgres>;

const MAX_MONITORS_PER_USER = 50;
const MAX_NAME_CHARS = 120;
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 24 * 60;
const MAX_ERROR_CHARS = 500;
const MAX_EVENT_MESSAGE_CHARS = 700;
const FIELDS = 'id, user_id AS "userId", name, url, interval_minutes AS "intervalMinutes", status, health, next_check_at AS "nextCheckAt", last_checked_at AS "lastCheckedAt", last_healthy_at AS "lastHealthyAt", last_status_code AS "lastStatusCode", last_latency_ms AS "lastLatencyMs", last_error AS "lastError", lease_owner AS "leaseOwner", lease_until AS "leaseUntil", created_at AS "createdAt", updated_at AS "updatedAt"';
const PUBLIC_FIELDS = 'id, user_id AS "userId", name, url, interval_minutes AS "intervalMinutes", status, health, next_check_at AS "nextCheckAt", last_checked_at AS "lastCheckedAt", last_healthy_at AS "lastHealthyAt", last_status_code AS "lastStatusCode", last_latency_ms AS "lastLatencyMs", last_error AS "lastError", created_at AS "createdAt", updated_at AS "updatedAt"';
const EVENT_FIELDS = 'id, monitor_id AS "monitorId", user_id AS "userId", type, health, message, status_code AS "statusCode", latency_ms AS "latencyMs", created_at AS "createdAt"';

type CheckEvent = Omit<FroshMonitorEvent, "id" | "monitorId" | "userId" | "createdAt">;

function text(value: unknown, label: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${label} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  const cleaned = value.trim();
  if ((required && !cleaned) || cleaned.length > max || /[\u0000-\u001f\u007f]/.test(cleaned)) {
    throw new Error(`${label} is invalid or too long`);
  }
  return cleaned || undefined;
}

function interval(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < MIN_INTERVAL_MINUTES || Number(value) > MAX_INTERVAL_MINUTES) {
    throw new Error(`intervalMinutes must be an integer between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}`);
  }
  return Number(value);
}

function creation(input: FroshHttpMonitorCreateInput): FroshHttpMonitorCreateInput {
  const userId = text(input.userId, "userId", 200, true)!;
  const name = text(input.name, "name", MAX_NAME_CHARS, true)!;
  const url = validateResearchUrl(text(input.url, "url", 2_000, true)!).toString();
  return { userId, name, url, intervalMinutes: interval(input.intervalMinutes) };
}

function patch(input: FroshHttpMonitorPatch): FroshHttpMonitorPatch {
  const result: FroshHttpMonitorPatch = {};
  if (Object.hasOwn(input, "name")) result.name = text(input.name, "name", MAX_NAME_CHARS, true)!;
  if (Object.hasOwn(input, "intervalMinutes")) result.intervalMinutes = interval(input.intervalMinutes);
  if (Object.hasOwn(input, "status")) {
    if (input.status !== "active" && input.status !== "paused") throw new Error("status must be active or paused");
    result.status = input.status;
  }
  return result;
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  return Math.max(1, Math.min(value ?? fallback, max));
}

function publicMonitor(monitor: FroshHttpMonitor): FroshHttpMonitor {
  const { leaseOwner: _owner, leaseUntil: _until, ...result } = monitor;
  return result;
}

function checkInput(check: FroshHttpMonitorCheck): FroshHttpMonitorCheck {
  if (!["healthy", "degraded", "down"].includes(check.health)) throw new Error("Invalid monitor health");
  if (!check.lastCheckedAt || !Number.isFinite(Date.parse(check.lastCheckedAt))) throw new Error("Invalid monitor check timestamp");
  if (check.lastHealthyAt && !Number.isFinite(Date.parse(check.lastHealthyAt))) throw new Error("Invalid monitor healthy timestamp");
  if (check.nextCheckAt && !Number.isFinite(Date.parse(check.nextCheckAt))) throw new Error("Invalid monitor next-check timestamp");
  if (check.lastStatusCode !== undefined && (!Number.isInteger(check.lastStatusCode) || check.lastStatusCode < 100 || check.lastStatusCode > 599)) throw new Error("Invalid monitor status code");
  if (check.lastLatencyMs !== undefined && (!Number.isInteger(check.lastLatencyMs) || check.lastLatencyMs < 0 || check.lastLatencyMs > 120_000)) throw new Error("Invalid monitor latency");
  const lastError = text(check.lastError, "lastError", MAX_ERROR_CHARS);
  return { ...check, ...(lastError ? { lastError } : {}) };
}

function checkedEvent(event: CheckEvent): CheckEvent {
  const message = text(event.message, "event message", MAX_EVENT_MESSAGE_CHARS, true)!;
  if (!["healthy", "degraded", "down", "recovered"].includes(event.type)) throw new Error("Invalid monitor event type");
  if (!["healthy", "degraded", "down"].includes(event.health)) throw new Error("Invalid monitor event health");
  return { ...event, message };
}

export class InMemoryMonitorStore implements FroshMonitorStore {
  private readonly monitors = new Map<string, FroshHttpMonitor>();
  private readonly events = new Map<string, FroshMonitorEvent>();

  async list(userId: string, limit?: number) {
    return [...this.monitors.values()]
      .filter((monitor) => monitor.userId === userId)
      .sort((a, b) => (a.nextCheckAt ?? "9999").localeCompare(b.nextCheckAt ?? "9999") || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, clampLimit(limit, 100, 200))
      .map(publicMonitor);
  }

  async get(id: string, userId: string) {
    const found = this.monitors.get(id);
    return found?.userId === userId ? publicMonitor(found) : null;
  }

  async create(input: FroshHttpMonitorCreateInput) {
    const next = creation(input);
    if ([...this.monitors.values()].filter((monitor) => monitor.userId === next.userId).length >= MAX_MONITORS_PER_USER) {
      throw new Error("Monitor limit reached for this user");
    }
    const now = new Date().toISOString();
    const monitor: FroshHttpMonitor = {
      id: crypto.randomUUID(), ...next, status: "active", health: "unknown", nextCheckAt: now, createdAt: now, updatedAt: now,
    };
    this.monitors.set(monitor.id, monitor);
    return publicMonitor(monitor);
  }

  async update(id: string, userId: string, input: FroshHttpMonitorPatch) {
    const current = this.monitors.get(id);
    if (!current || current.userId !== userId) return null;
    if (current.leaseUntil && Date.parse(current.leaseUntil) > Date.now()) throw new Error("Monitor is currently checking");
    const nextPatch = patch(input);
    const activated = nextPatch.status === "active" && current.status === "paused";
    const next: FroshHttpMonitor = {
      ...current,
      ...nextPatch,
      ...(activated ? { nextCheckAt: new Date().toISOString() } : {}),
      ...(nextPatch.status === "paused" ? { nextCheckAt: undefined } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.monitors.set(id, next);
    return publicMonitor(next);
  }

  async delete(id: string, userId: string) {
    const current = this.monitors.get(id);
    if (!current || current.userId !== userId) return false;
    if (current.leaseUntil && Date.parse(current.leaseUntil) > Date.now()) throw new Error("Monitor is currently checking");
    this.monitors.delete(id);
    for (const [eventId, event] of this.events) if (event.monitorId === id) this.events.delete(eventId);
    return true;
  }

  async listEvents(monitorId: string, userId: string, limit?: number) {
    if (!(await this.get(monitorId, userId))) return [];
    return [...this.events.values()]
      .filter((event) => event.monitorId === monitorId && event.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, clampLimit(limit, 50, 200));
  }

  async listDue(now: Date, limit?: number) {
    return [...this.monitors.values()]
      .filter((monitor) => monitor.status === "active" && Boolean(monitor.nextCheckAt) && Date.parse(monitor.nextCheckAt!) <= now.getTime())
      .sort((a, b) => (a.nextCheckAt ?? "").localeCompare(b.nextCheckAt ?? ""))
      .slice(0, clampLimit(limit, 20, 100))
      .map(publicMonitor);
  }

  async claimDue(id: string, userId: string, owner: string, leaseMs: number) {
    const current = this.monitors.get(id);
    if (!current || current.userId !== userId || current.status !== "active" || !current.nextCheckAt || Date.parse(current.nextCheckAt) > Date.now()) return null;
    if (current.leaseUntil && Date.parse(current.leaseUntil) > Date.now()) return null;
    const next = { ...current, leaseOwner: owner, leaseUntil: new Date(Date.now() + leaseMs).toISOString(), updatedAt: new Date().toISOString() };
    this.monitors.set(id, next);
    return next;
  }

  async claimNow(id: string, userId: string, owner: string, leaseMs: number) {
    const current = this.monitors.get(id);
    if (!current || current.userId !== userId || current.status !== "active") return null;
    if (current.leaseUntil && Date.parse(current.leaseUntil) > Date.now()) return null;
    const next = { ...current, leaseOwner: owner, leaseUntil: new Date(Date.now() + leaseMs).toISOString(), updatedAt: new Date().toISOString() };
    this.monitors.set(id, next);
    return next;
  }

  async recordCheck(id: string, userId: string, owner: string, check: FroshHttpMonitorCheck, event?: CheckEvent) {
    const current = this.monitors.get(id);
    if (!current || current.userId !== userId || current.leaseOwner !== owner || !current.leaseUntil || Date.parse(current.leaseUntil) <= Date.now()) return null;
    const nextCheck = checkInput(check);
    const next = { ...current, ...nextCheck, leaseOwner: undefined, leaseUntil: undefined, updatedAt: new Date().toISOString() };
    this.monitors.set(id, next);
    if (event) {
      const value = checkedEvent(event);
      const record: FroshMonitorEvent = { id: crypto.randomUUID(), monitorId: id, userId, ...value, createdAt: new Date().toISOString() };
      this.events.set(record.id, record);
    }
    return publicMonitor(next);
  }

  async releaseLease(id: string, userId: string, owner: string) {
    const current = this.monitors.get(id);
    if (!current || current.userId !== userId || current.leaseOwner !== owner) return false;
    this.monitors.set(id, { ...current, leaseOwner: undefined, leaseUntil: undefined, updatedAt: new Date().toISOString() });
    return true;
  }
}

export class PostgresMonitorStore implements FroshMonitorStore {
  constructor(private readonly sql: Sql) {}

  async list(userId: string, limit?: number) {
    return this.sql.unsafe<FroshHttpMonitor[]>(
      `SELECT ${PUBLIC_FIELDS} FROM frosh_http_monitors WHERE user_id=$1 ORDER BY next_check_at NULLS LAST, updated_at DESC LIMIT $2`,
      [userId, clampLimit(limit, 100, 200)],
    );
  }

  async get(id: string, userId: string) {
    const rows = await this.sql.unsafe<FroshHttpMonitor[]>(`SELECT ${PUBLIC_FIELDS} FROM frosh_http_monitors WHERE id=$1 AND user_id=$2 LIMIT 1`, [id, userId]);
    return rows[0] ?? null;
  }

  async create(input: FroshHttpMonitorCreateInput) {
    const next = creation(input);
    return this.sql.begin(async (sql) => {
      await sql.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [next.userId]);
      const count = await sql.unsafe<{ count: number }[]>("SELECT COUNT(*)::int AS count FROM frosh_http_monitors WHERE user_id=$1", [next.userId]);
      if ((count[0]?.count ?? 0) >= MAX_MONITORS_PER_USER) throw new Error("Monitor limit reached for this user");
      const rows = await sql.unsafe<FroshHttpMonitor[]>(
        `INSERT INTO frosh_http_monitors(id,user_id,name,url,interval_minutes,status,health,next_check_at)
         VALUES($1,$2,$3,$4,$5,'active','unknown',NOW()) RETURNING ${PUBLIC_FIELDS}`,
        [crypto.randomUUID(), next.userId, next.name, next.url, next.intervalMinutes],
      );
      return rows[0];
    });
  }

  async update(id: string, userId: string, input: FroshHttpMonitorPatch) {
    const currentRows = await this.sql.unsafe<FroshHttpMonitor[]>(`SELECT ${FIELDS} FROM frosh_http_monitors WHERE id=$1 AND user_id=$2 LIMIT 1`, [id, userId]);
    const current = currentRows[0];
    if (!current) return null;
    if (current.leaseUntil && Date.parse(current.leaseUntil) > Date.now()) throw new Error("Monitor is currently checking");
    const next = { ...current, ...patch(input) };
    const activated = next.status === "active" && current.status === "paused";
    const rows = await this.sql.unsafe<FroshHttpMonitor[]>(
      `UPDATE frosh_http_monitors SET name=$3,interval_minutes=$4,status=$5,
       next_check_at=CASE WHEN $5='paused' THEN NULL WHEN $6 THEN NOW() ELSE next_check_at END,updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND (lease_until IS NULL OR lease_until <= NOW()) RETURNING ${PUBLIC_FIELDS}`,
      [id, userId, next.name, next.intervalMinutes, next.status, activated],
    );
    if (!rows[0]) throw new Error("Monitor is currently checking");
    return rows[0];
  }

  async delete(id: string, userId: string) {
    const result = await this.sql.unsafe("DELETE FROM frosh_http_monitors WHERE id=$1 AND user_id=$2 AND (lease_until IS NULL OR lease_until <= NOW())", [id, userId]);
    return result.count > 0;
  }

  async listEvents(monitorId: string, userId: string, limit?: number) {
    return this.sql.unsafe<FroshMonitorEvent[]>(
      `SELECT ${EVENT_FIELDS} FROM frosh_monitor_events WHERE monitor_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT $3`,
      [monitorId, userId, clampLimit(limit, 50, 200)],
    );
  }

  async listDue(now: Date, limit?: number) {
    return this.sql.unsafe<FroshHttpMonitor[]>(
      `SELECT ${PUBLIC_FIELDS} FROM frosh_http_monitors WHERE status='active' AND next_check_at <= $1
       AND (lease_until IS NULL OR lease_until <= $1) ORDER BY next_check_at ASC LIMIT $2`,
      [now.toISOString(), clampLimit(limit, 20, 100)],
    );
  }

  async claimDue(id: string, userId: string, owner: string, leaseMs: number) {
    const rows = await this.sql.unsafe<FroshHttpMonitor[]>(
      `UPDATE frosh_http_monitors SET lease_owner=$3,lease_until=NOW()+($4 * INTERVAL '1 millisecond'),updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND status='active' AND next_check_at <= NOW()
       AND (lease_until IS NULL OR lease_until <= NOW()) RETURNING ${FIELDS}`,
      [id, userId, owner, leaseMs],
    );
    return rows[0] ?? null;
  }

  async claimNow(id: string, userId: string, owner: string, leaseMs: number) {
    const rows = await this.sql.unsafe<FroshHttpMonitor[]>(
      `UPDATE frosh_http_monitors SET lease_owner=$3,lease_until=NOW()+($4 * INTERVAL '1 millisecond'),updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND status='active' AND (lease_until IS NULL OR lease_until <= NOW()) RETURNING ${FIELDS}`,
      [id, userId, owner, leaseMs],
    );
    return rows[0] ?? null;
  }

  async recordCheck(id: string, userId: string, owner: string, input: FroshHttpMonitorCheck, event?: CheckEvent) {
    const check = checkInput(input);
    const health = check.health as "healthy" | "degraded" | "down";
    const safeEvent = event ? checkedEvent(event) : undefined;
    return this.sql.begin(async (sql) => {
      const rows = await sql.unsafe<FroshHttpMonitor[]>(
        `UPDATE frosh_http_monitors SET health=$4,last_checked_at=$5,last_healthy_at=$6,last_status_code=$7,last_latency_ms=$8,last_error=$9,next_check_at=$10,
         lease_owner=NULL,lease_until=NULL,updated_at=NOW()
         WHERE id=$1 AND user_id=$2 AND lease_owner=$3 AND lease_until > NOW() RETURNING ${PUBLIC_FIELDS}`,
        [id, userId, owner, health, check.lastCheckedAt!, check.lastHealthyAt ?? null, check.lastStatusCode ?? null, check.lastLatencyMs ?? null, check.lastError ?? null, check.nextCheckAt ?? null],
      );
      const monitor = rows[0];
      if (!monitor) return null;
      if (safeEvent) {
        await sql.unsafe(
          `INSERT INTO frosh_monitor_events(id,monitor_id,user_id,type,health,message,status_code,latency_ms)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [crypto.randomUUID(), id, userId, safeEvent.type, safeEvent.health, safeEvent.message, safeEvent.statusCode ?? null, safeEvent.latencyMs ?? null],
        );
      }
      return monitor;
    });
  }

  async releaseLease(id: string, userId: string, owner: string) {
    const result = await this.sql.unsafe(
      "UPDATE frosh_http_monitors SET lease_owner=NULL,lease_until=NULL,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND lease_owner=$3",
      [id, userId, owner],
    );
    return result.count > 0;
  }
}
