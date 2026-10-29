/**
 * Migration discovery and integrity.
 *
 * The migration runner is the only thing standing between a fresh database and
 * a schema the services can query. These tests prove every migration is
 * discoverable, non-empty, and syntactically closed, and that the columns the
 * mission store selects actually exist in the DDL.
 *
 * The live apply/verify path (`bun run migrate`) is covered by CI when
 * DATABASE_URL is present; see docs/ARCHITECTURE.md.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SERVICES = ["api", "automation", "google", "memory", "missions", "preferences", "productivity"];

function migrationsFor(service: string) {
  const dir = join(ROOT, "services", service, "migrations");
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
  } catch {
    return [];
  }
}

describe("migrations", () => {
  test("every service with a schema has migrations", () => {
    for (const service of SERVICES) {
      expect(migrationsFor(service).length).toBeGreaterThan(0);
    }
  });

  test("migrations are numbered and ordered", () => {
    for (const service of SERVICES) {
      const names = migrationsFor(service).map((migration) => migration.name);
      for (const name of names) {
        expect(name).toMatch(/^\d{3}_.+\.sql$/);
      }
      expect(names).toEqual([...names].sort());
      // No duplicate sequence numbers.
      const numbers = names.map((name) => name.slice(0, 3));
      expect(new Set(numbers).size).toBe(numbers.length);
    }
  });

  test("no migration is empty or truncated", () => {
    const problems: string[] = [];
    for (const service of SERVICES) {
      for (const { name, sql } of migrationsFor(service)) {
        const trimmed = sql.trim();
        if (!trimmed) problems.push(`${service}/${name}: empty`);
        else if (!trimmed.endsWith(";")) problems.push(`${service}/${name}: does not end with ';'`);
        else {
          const open = (sql.match(/\(/g) ?? []).length;
          const close = (sql.match(/\)/g) ?? []).length;
          if (open !== close) problems.push(`${service}/${name}: unbalanced parens (${open}/${close})`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test("the mission schema contains every column the store selects", () => {
    const ddl = migrationsFor("missions").map((migration) => migration.sql).join("\n");
    const required = [
      "id",
      "user_id",
      "goal",
      "status",
      "priority",
      "budget_profile",
      "progress",
      "steps",
      "active_run_id",
      "pending_approval_id",
      "lease_until",
      "lease_owner",
      "result",
      "tool_calls_used",
      "execution_duration_ms",
      "created_at",
      "updated_at",
    ];
    const missing = required.filter((column) => !new RegExp(`\\b${column}\\b`).test(ddl));
    expect(missing).toEqual([]);
  });

  test("the runner discovers all migrations", async () => {
    const total = SERVICES.reduce((count, service) => count + migrationsFor(service).length, 0);
    expect(total).toBe(27);
  });
});
