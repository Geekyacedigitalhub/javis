import { describe, expect, test } from "bun:test";
import {
  duration,
  evidenceLabel,
  exitCodeOf,
  isVerified,
  summarise,
  type RunLike,
  type ToolCall,
} from "../apps/web/app/runs/summary";

/**
 * The page's evidence rules.
 *
 * The whole promise of the coding loop is that FROSH does not claim success
 * without proof. A UI that quietly rounded "validation ran" up to "verified"
 * would undo that in the one place a person actually looks, so the rule is
 * tested rather than trusted to careful wording.
 */

function call(name: string, overrides: Partial<ToolCall> = {}): ToolCall {
  return { id: name + Math.random().toString(16).slice(2), name, arguments: {}, status: "completed", ...overrides };
}

function validation(exitCode: number, command = "bun test"): ToolCall {
  return call("workspace_validate", { arguments: { command }, result: { exitCode, stdout: "", stderr: "" } });
}

function edit(): ToolCall {
  return call("workspace_write", { arguments: { path: "a.txt" } , result: { bytes: 1 } });
}

function run(toolCalls: ToolCall[]): RunLike {
  return { goal: "g", status: "completed", toolCalls, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:10.000Z" };
}

describe("exitCodeOf", () => {
  test("reads a real exit code", () => {
    expect(exitCodeOf(validation(0))).toBe(0);
    expect(exitCodeOf(validation(2))).toBe(2);
  });

  test("treats a result without an exit code as no evidence", () => {
    expect(exitCodeOf(call("workspace_validate", { result: { note: "done" } }))).toBeNull();
    expect(exitCodeOf(call("workspace_validate", { result: undefined }))).toBeNull();
    expect(exitCodeOf(call("workspace_validate", { result: "ok" }))).toBeNull();
  });
});

describe("summarise", () => {
  test("counts edits and validations", () => {
    const evidence = summarise(run([edit(), validation(0, "bun run check")]));
    expect(evidence).toEqual({ edits: 1, validations: 1, lastCommand: "bun run check", exitCode: 0 });
  });

  test("uses the most recent validation", () => {
    const evidence = summarise(run([edit(), validation(1, "first"), edit(), validation(0, "second")]));
    expect(evidence.lastCommand).toBe("second");
    expect(evidence.exitCode).toBe(0);
  });

  test("a validation that never completed is not counted", () => {
    const unfinished = call("workspace_validate", { status: "failed", arguments: { command: "bun test" } });
    expect(summarise(run([edit(), unfinished])).validations).toBe(0);
  });

  test("edits that failed do not count as edits", () => {
    const failedEdit = call("workspace_write", { status: "failed" });
    expect(summarise(run([failedEdit])).edits).toBe(0);
  });

  test("nothing ran, nothing counted", () => {
    expect(summarise(run([]))).toEqual({ edits: 0, validations: 0, lastCommand: "", exitCode: null });
  });
});

describe("evidenceLabel", () => {
  test("only a zero exit is verified", () => {
    expect(evidenceLabel(run([edit(), validation(0)]))).toBe("verified");
    expect(isVerified(run([edit(), validation(0)]))).toBe(true);
  });

  test("a non-zero exit is explicitly not verified", () => {
    expect(evidenceLabel(run([edit(), validation(1)]))).toBe("failed_validation");
    expect(isVerified(run([edit(), validation(1)]))).toBe(false);
  });

  test("an edit with no validation is not verified", () => {
    expect(evidenceLabel(run([edit()]))).toBe("unvalidated");
    expect(isVerified(run([edit()]))).toBe(false);
  });

  test("an empty run has no evidence at all", () => {
    expect(evidenceLabel(run([]))).toBe("none");
    expect(isVerified(run([]))).toBe(false);
  });

  test("a validation with no exit code is not verification", () => {
    const noVerdict = call("workspace_validate", { arguments: { command: "x" }, result: { ok: true } });
    expect(evidenceLabel(run([edit(), noVerdict]))).toBe("unvalidated");
  });
});

describe("formatting", () => {
  test("duration is human and never negative", () => {
    expect(duration(run([]))).toBe("10s");
    expect(
      duration({ ...run([]), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:02:05.000Z" }),
    ).toBe("2m 5s");
    expect(
      duration({ ...run([]), createdAt: "2026-01-01T00:01:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }),
    ).toBe("");
  });
});
