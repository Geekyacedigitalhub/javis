/**
 * Parse-integrity guard.
 *
 * Six source files in this repository were once truncated mid-content by a bad
 * write: `http.ts` lost its closing braces, `github-tools.ts` lost a backtick,
 * and three .tsx pages lost entire JSX blocks mid-line. Nothing in the repo
 * detected it before it reached `main`.
 *
 * This test parses every source file with the TypeScript parser and fails on
 * any syntax diagnostic, which is exactly the class of damage a truncated or
 * partially-written file produces.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..");
const SCAN_DIRS = ["services", "packages", "apps", "scripts"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".expo",
  "dist",
  "build",
  "out",
  "coverage",
  "android",
  "ios",
]);

function collect(dir: string, found: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collect(join(dir, entry.name), found);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

function scriptKindOf(file: string) {
  return file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

type ParseDiagnostic = ts.Diagnostic & { start?: number };

const files = SCAN_DIRS.flatMap((dir) => collect(join(ROOT, dir))).sort();

describe("source parse integrity", () => {
  test("the scan actually finds source files", () => {
    // Guards against a refactor that silently makes this suite a no-op.
    expect(files.length).toBeGreaterThan(60);
    expect(files.some((file) => file.endsWith("services/api/src/http.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("apps/web/app/missions/page.tsx"))).toBe(true);
  });

  test("every source file parses without syntax errors", () => {
    const failures: string[] = [];

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file));
      // parseDiagnostics is populated by the parser but omitted from the public typings.
      const diagnostics = ((source as unknown as { parseDiagnostics?: ParseDiagnostic[] }).parseDiagnostics ??
        []) as ParseDiagnostic[];

      if (!diagnostics.length) continue;

      const lines = text.split("\n");
      const details = diagnostics.slice(0, 3).map((diagnostic) => {
        const position = typeof diagnostic.start === "number" ? diagnostic.start : 0;
        let line = 1;
        let column = 1;
        for (let i = 0; i < position && i < text.length; i += 1) {
          if (text[i] === "\n") {
            line += 1;
            column = 1;
          } else {
            column += 1;
          }
        }
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
        return `    line ${line}:${column} — ${message}\n      ${(lines[line - 1] ?? "").slice(0, 120)}`;
      });

      failures.push(`  ${relative(ROOT, file)} (${diagnostics.length} diagnostic(s))\n${details.join("\n")}`);
    }

    expect(failures).toEqual([]);
  });

  test("no source file ends mid-statement", () => {
    // A truncated file almost always fails to parse, but this catches the
    // narrower case of a file that closes cleanly yet lost its tail: the final
    // meaningful character must not leave a bracket or quote dangling.
    const suspicious: string[] = [];

    for (const file of files) {
      const text = readFileSync(file, "utf8").trimEnd();
      if (!text) {
        suspicious.push(`${relative(ROOT, file)} — empty file`);
        continue;
      }
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file));
      const diagnostics = ((source as unknown as { parseDiagnostics?: ParseDiagnostic[] }).parseDiagnostics ??
        []) as ParseDiagnostic[];
      if (diagnostics.length) {
        suspicious.push(`${relative(ROOT, file)} — does not parse`);
      }
    }

    expect(suspicious).toEqual([]);
  });

  test("the mobile app never imports server-only code", () => {
    // The Android app once imported services/memory/src/conversation-memory-factory,
    // which pulls the `postgres` driver into the React Native bundle. There are no
    // TCP sockets for that driver on a phone, so the feature could never work and
    // it silently coupled the client to the server's storage layer.
    const offenders: string[] = [];
    const mobileFiles = files.filter((file) => file.includes(`${join("apps", "mobile")}`));

    expect(mobileFiles.length).toBeGreaterThan(10);

    for (const file of mobileFiles) {
      const source = readFileSync(file, "utf8");
      // Only real imports count; comments and type-only re-exports are fine.
      const imports = source.match(/(?:^|\n)\s*import[^;]*?from\s*["']([^"']+)["']/g) ?? [];
      for (const statement of imports) {
        const specifier = statement.match(/from\s*["']([^"']+)["']/)?.[1] ?? "";
        const isTypeOnly = /import\s+type\b/.test(statement);
        // A type-only import is erased at build time, so it cannot ship the driver.
        if (isTypeOnly) continue;
        if (/^(\.\.\/)+services\//.test(specifier)) {
          offenders.push(`${relative(ROOT, file)} -> ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("the previously truncated files keep their restored size", () => {
    // Regression floor: these files are far longer than the damaged versions
    // (http.ts 1799 -> 1861 lines, pages 23/14/14 -> 300+). A sudden collapse
    // to a handful of lines means a bad write happened again.
    const minimums: Array<[string, number]> = [
      ["services/api/src/http.ts", 1800],
      ["services/missions/src/store.ts", 340],
      ["apps/web/app/missions/page.tsx", 250],
      ["apps/web/app/missions/[id]/page.tsx", 350],
      ["apps/web/app/automations/page.tsx", 180],
      ["services/tools/src/github-tools.ts", 100],
    ];

    const tooSmall: string[] = [];
    for (const [path, minimum] of minimums) {
      const text = readFileSync(join(ROOT, path), "utf8");
      const lines = text.split("\n").length;
      if (lines < minimum) tooSmall.push(`${path}: ${lines} lines, expected at least ${minimum}`);
    }
    expect(tooSmall).toEqual([]);
  });
});
