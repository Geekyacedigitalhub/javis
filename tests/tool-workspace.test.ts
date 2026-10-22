import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Importing the index registers every tool; the registry alone is an empty map.
import { getTool } from "../services/tools/src";

/**
 * Regression: the workspace root must be read per call.
 *
 * `developer-tools.ts` used to capture `FROSH_WORKSPACE` at import, so the
 * effective workspace was whatever the environment held the first time anything
 * loaded the tool registry — the process's import order decided where files
 * went. It surfaced as a CI failure: a coding-loop test wrote `proof.txt` into a
 * different temporary directory than the one it was asserting on, because
 * another test file had loaded the registry first.
 *
 * `command-tools.ts` already resolved the root per call; this test pins the two
 * to the same behaviour so they cannot drift apart again.
 */

const originalWorkspace = process.env.FROSH_WORKSPACE;

afterAll(() => {
  if (originalWorkspace === undefined) delete process.env.FROSH_WORKSPACE;
  else process.env.FROSH_WORKSPACE = originalWorkspace;
});

describe("workspace root", () => {
  test("follows FROSH_WORKSPACE as it changes, rather than freezing the first value", async () => {
    const first = mkdtempSync(join(tmpdir(), "frosh-ws-a-"));
    const second = mkdtempSync(join(tmpdir(), "frosh-ws-b-"));

    const write = getTool("workspace_write");
    expect(write).toBeDefined();

    process.env.FROSH_WORKSPACE = first;
    await write!.execute({ path: "first.txt", content: "one" });

    process.env.FROSH_WORKSPACE = second;
    await write!.execute({ path: "second.txt", content: "two" });

    expect(existsSync(join(first, "first.txt"))).toBe(true);
    expect(existsSync(join(second, "second.txt"))).toBe(true);
    // Neither call escaped into the other directory.
    expect(existsSync(join(first, "second.txt"))).toBe(false);
    expect(existsSync(join(second, "first.txt"))).toBe(false);
  });

  test("still refuses a path outside the workspace after the root changes", async () => {
    process.env.FROSH_WORKSPACE = mkdtempSync(join(tmpdir(), "frosh-ws-c-"));
    const write = getTool("workspace_write")!;

    await expect(write.execute({ path: "../escape.txt", content: "no" })).rejects.toThrow(
      "Path is outside the configured FROSH workspace",
    );
  });
});
