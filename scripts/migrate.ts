#!/usr/bin/env bun
/**
 * FROSH migration runner.
 *
 * Applies every services/<service>/migrations/*.sql file exactly once, in
 * lexicographic order per service, and records each application in
 * frosh_schema_migrations with a checksum so edited migrations are detected
 * instead of silently diverging.
 *
 * Usage:
 *   bun run scripts/migrate.ts --dry-run     # list what would run, no database needed
 *   DATABASE_URL=... bun run scripts/migrate.ts
 *   DATABASE_URL=... bun run scripts/migrate.ts --verify
 */
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import postgres from "postgres";

type Migration = {
  service: string;
  filename: string;
  path: string;
  sql: string;
  checksum: string;
};

const ROOT = join(import.meta.dir, "..");
const SERVICES_DIR = join(ROOT, "services");
const LEDGER = "frosh_schema_migrations";

function checksumOf(sql: string) {
  return createHash("sha256").update(sql).digest("hex");
}

async function discoverMigrations(): Promise<Migration[]> {
  const services = (await readdir(SERVICES_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const migrations: Migration[] = [];
  for (const service of services) {
    const dir = join(SERVICES_DIR, service, "migrations");
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const filename of files.filter((name) => name.endsWith(".sql")).sort()) {
      const path = join(dir, filename);
      const sql = await readFile(path, "utf8");
      migrations.push({ service, filename, path, sql, checksum: checksumOf(sql) });
    }
  }

  // Deterministic global order: service name, then migration filename.
  return migrations.sort((a, b) =>
    a.service === b.service ? a.filename.localeCompare(b.filename) : a.service.localeCompare(b.service),
  );
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const verifyOnly = args.has("--verify");
  const migrations = await discoverMigrations();

  if (!migrations.length) {
    console.error("No migrations found under services/*/migrations.");
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    console.log(`FROSH migrations (${migrations.length}) — dry run, nothing applied\n`);
    for (const migration of migrations) {
      console.log(`  ${relative(ROOT, migration.path)}  ${migration.checksum.slice(0, 12)}`);
    }
    return;
  }

  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error("DATABASE_URL is required unless --dry-run is used.");
    process.exitCode = 1;
    return;
  }

  const sql = postgres(url, { max: 1, onnotice: () => undefined });

  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${LEDGER} (
        service TEXT NOT NULL,
        filename TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (service, filename)
      )
    `);

    const applied = await sql.unsafe<{ service: string; filename: string; checksum: string }[]>(
      `SELECT service, filename, checksum FROM ${LEDGER}`,
    );
    const appliedByKey = new Map(applied.map((row) => [`${row.service}/${row.filename}`, row]));

    let appliedCount = 0;
    let skippedCount = 0;
    const problems: string[] = [];

    for (const migration of migrations) {
      const key = `${migration.service}/${migration.filename}`;
      const previous = appliedByKey.get(key);

      if (previous) {
        if (previous.checksum !== migration.checksum) {
          problems.push(
            `checksum drift: ${key} was applied with ${previous.checksum.slice(0, 12)} but the file is now ${migration.checksum.slice(0, 12)}`,
          );
        }
        skippedCount += 1;
        continue;
      }

      if (verifyOnly) {
        problems.push(`pending: ${key} has not been applied`);
        continue;
      }

      // Each migration runs in its own transaction, together with its ledger row,
      // so a failure leaves the database exactly as it was before the migration.
      await sql.begin(async (tx) => {
        await tx.unsafe(migration.sql);
        await tx.unsafe(`INSERT INTO ${LEDGER} (service, filename, checksum) VALUES ($1, $2, $3)`, [
          migration.service,
          migration.filename,
          migration.checksum,
        ]);
      });
      appliedCount += 1;
      console.log(`applied  ${key}`);
    }

    console.log(
      `\n${appliedCount} applied, ${skippedCount} already present, ${migrations.length} discovered.`,
    );

    if (problems.length) {
      console.error("\nProblems:");
      for (const problem of problems) console.error("  - " + problem);
      process.exitCode = 1;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

await main();
