import { LOOP_WORKSPACE } from "./loop.setup";

import { beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FroshToolCall } from "../packages/types/src/javis";
import type { ProviderClient, ProviderResponse } from "../services/ai/src/provider";
import {
  CodingLoop,
  collectCodingEvidence,
  deriveCodingPhase,
} from "../services/ai/src/coding-loop";
import { agentRunStore } from "../services/ai/src/coding-session";
import { approvalStore } from "../services/tools/src";

/**
 * A provider that replays a fixed script. The loop's job is to decide what to
 * do with a model's output, so the tests supply the output and check the
 * decisions — including the ones that refuse to believe it.
 */
// Set here rather than at import: another test file may legitimately point the
// workspace somewhere else, and whichever file ran last would otherwise win.
beforeAll(() => {
  process.env.FROSH_WORKSPACE = LOOP_WORKSPACE;
});

class ScriptedProvider implements ProviderClient {
  readonly prompts: string[] = [];

  constructor(private readonly script: ProviderResponse[]) {}

  async generate(input: Parameters<ProviderClient["generate"]>[0]): Promise<ProviderResponse> {
    this.prompts.push(input.messages.map((message) => message.content).join("\n---\n"));
    const next = this.script.shift();
    if (!next) throw new Error("Scripted provider ran out of responses");
    return next;
  }
}

function call(name: string, args: Record<string, unknown> = {}): FroshToolCall {
  return { id: `call-${name}-${Math.random().toString(16).slice(2)}`, name, arguments: args, status: "planned" };
}

function validation(exitCode: number, command = "bun test"): FroshToolCall {
  return { ...call("workspace_validate", { command }), status: "completed", result: { exitCode, stdout: "", stderr: "" } };
}

function edit(): FroshToolCall {
  return { ...call("workspace_write", { path: "a.txt", content: "x" }), status: "completed", result: { bytes: 1 } };
}

describe("deriveCodingPhase", () => {
  test("a run with no tool calls is planning", () => {
    expect(deriveCodingPhase([])).toBe("plan");
  });

  test("reading without changing is inspection", () => {
    expect(deriveCodingPhase([{ ...call("workspace_list"), status: "completed", result: [] }])).toBe("inspect");
  });

  test("an edit with nothing validating it is not done", () => {
    expect(deriveCodingPhase([edit()])).toBe("test");
  });

  test("a passing validation moves to review", () => {
    expect(deriveCodingPhase([edit(), validation(0)])).toBe("review");
  });

  test("a failure nothing has answered needs a fix", () => {
    expect(deriveCodingPhase([edit(), validation(1)])).toBe("fix");
  });

  test("a failure that was already answered needs testing again", () => {
    expect(deriveCodingPhase([edit(), validation(1), edit()])).toBe("test");
  });

  test("a validation that never completed proves nothing", () => {
    const unfinished: FroshToolCall = { ...call("workspace_validate", { command: "bun test" }), status: "failed" };
    expect(deriveCodingPhase([edit(), unfinished])).toBe("test");
  });

  test("a completed validation without an exit code proves nothing", () => {
    const noVerdict: FroshToolCall = { ...call("workspace_validate", { command: "bun test" }), status: "completed", result: { note: "done" } };
    expect(deriveCodingPhase([edit(), noVerdict])).toBe("test");
  });
});

describe("collectCodingEvidence", () => {
  test("counts what actually happened", () => {
    const evidence = collectCodingEvidence([edit(), validation(0, "bun run check")]);
    expect(evidence.edits).toBe(1);
    expect(evidence.validations).toBe(1);
    expect(evidence.lastValidation).toEqual({ command: "bun run check", exitCode: 0 });
  });

  test("is empty when nothing ran", () => {
    expect(collectCodingEvidence([])).toEqual({ edits: 0, validations: 0, lastValidation: undefined });
  });
});

describe("CodingLoop refuses unproven claims", () => {
  test("a model that says it is done without validating does not complete the run", async () => {
    const model = new ScriptedProvider([
      { message: "All done! Everything is implemented and the tests pass.", toolCalls: [] },
      { message: "I have finished. Tests pass.", toolCalls: [] },
    ]);
    const loop = new CodingLoop(model);

    const run = await loop.start({ goal: "Add a retry to the uploader" });

    expect(run.status).toBe("failed");
    expect(run.error).toBe("Model reported completion without validation evidence");
    expect(run.result).toContain("stopped without claiming success");
    // It is asked once, plainly, to actually validate.
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[1]).toContain("claimed completion without a validation result");
  });

  test("a model that never calls a tool at all still cannot complete", async () => {
    const loop = new CodingLoop(new ScriptedProvider([{ message: "Done.", toolCalls: [] }, { message: "Done.", toolCalls: [] }]));
    const run = await loop.start({ goal: "Clean up the config" });
    expect(run.status).toBe("failed");
    expect(collectCodingEvidence(run.toolCalls).validations).toBe(0);
  });

  test("a blank goal is refused before a run is created", async () => {
    const loop = new CodingLoop(new ScriptedProvider([]));
    await expect(loop.start({ goal: "   " })).rejects.toThrow("A coding goal is required");
  });
});

describe("CodingLoop with real tools", () => {
  test("parks for approval, runs the tool, validates, and only then completes", async () => {
    const model = new ScriptedProvider([
      // 1. inspect
      { message: "Looking at the workspace.", toolCalls: [call("workspace_list", {})] },
      // 2. change something (confirm -> parks)
      { message: "Writing the file.", toolCalls: [call("workspace_write", { path: "proof.txt", content: "verified content" })] },
      // 3. validate (confirm -> parks)
      { message: "Validating.", toolCalls: [call("workspace_validate", { command: "test -f proof.txt" })] },
      // 4. review, nothing left to do
      { message: "Wrote proof.txt and confirmed it exists.", toolCalls: [] },
    ]);
    const loop = new CodingLoop(model);

    const started = await loop.start({ goal: "Create proof.txt" });

    // Stopped on the write, and did not pretend the write happened.
    expect(started.status).toBe("waiting_approval");
    expect(started.pendingApprovalId).toBeDefined();
    expect(started.toolCalls).toHaveLength(1);
    expect(started.toolCalls[0].name).toBe("workspace_list");

    const writeApproval = await approvalStore.get(started.pendingApprovalId!);
    expect(writeApproval?.toolName).toBe("workspace_write");
    expect(writeApproval?.runId).toBe(started.id);

    const afterWrite = await loop.resumeAfterApproval(started.id, started.pendingApprovalId!);

    // The file genuinely exists because the approved tool really ran.
    expect(await readFile(join(LOOP_WORKSPACE, "proof.txt"), "utf8")).toBe("verified content");
    // Then it stopped on the validation, carrying only what it was doing —
    // not a claim that it succeeded.
    expect(afterWrite.status).toBe("waiting_approval");
    expect(afterWrite.result).toBe("Validating.");

    const validateApproval = await approvalStore.get(afterWrite.pendingApprovalId!);
    expect(validateApproval?.toolName).toBe("workspace_validate");

    const finished = await loop.resumeAfterApproval(afterWrite.id, afterWrite.pendingApprovalId!);

    expect(finished.status).toBe("completed");
    expect(finished.result).toContain("Verified:");
    expect(finished.result).toContain("`test -f proof.txt` exited 0");
    expect(collectCodingEvidence(finished.toolCalls)).toEqual({
      edits: 1,
      validations: 1,
      lastValidation: { command: "test -f proof.txt", exitCode: 0 },
    });
  });

  test("a failing validation sends the loop back to fixing, not to done", async () => {
    const model = new ScriptedProvider([
      { message: "Writing.", toolCalls: [call("workspace_write", { path: "missing.txt", content: "later" })] },
      { message: "Validating.", toolCalls: [call("workspace_validate", { command: "test -f does-not-exist.txt" })] },
      { message: "The check failed, so I will create the right file.", toolCalls: [call("workspace_write", { path: "does-not-exist.txt", content: "now it exists" })] },
    ]);
    const loop = new CodingLoop(model);

    const first = await loop.start({ goal: "Make the check pass" });
    const afterWrite = await loop.resumeAfterApproval(first.id, first.pendingApprovalId!);
    const afterFailure = await loop.resumeAfterApproval(afterWrite.id, afterWrite.pendingApprovalId!);

    // The validation really failed, and the run is parked on the correction.
    const failedValidation = afterFailure.toolCalls.find((entry) => entry.name === "workspace_validate");
    expect((failedValidation?.result as { exitCode: number }).exitCode).not.toBe(0);
    expect(afterFailure.status).toBe("waiting_approval");
    expect(deriveCodingPhase(afterFailure.toolCalls)).toBe("fix");
    expect(model.prompts.at(-1)).toContain("Phase: fix.");
  });

  test("rejecting the parked action stops the run honestly", async () => {
    const model = new ScriptedProvider([
      { message: "Writing.", toolCalls: [call("workspace_write", { path: "rejected.txt", content: "nope" })] },
    ]);
    const loop = new CodingLoop(model);

    const parked = await loop.start({ goal: "Write a file" });
    expect(parked.status).toBe("waiting_approval");

    const stopped = await loop.reject(parked.pendingApprovalId!);
    expect(stopped.status).toBe("failed");
    expect(stopped.error).toBe("User rejected approval");
    expect(stopped.result).toContain("rejected by the user");

    await expect(readFile(join(LOOP_WORKSPACE, "rejected.txt"), "utf8")).rejects.toThrow();
  });

  test("resuming with the wrong approval is refused", async () => {
    const model = new ScriptedProvider([
      { message: "Writing.", toolCalls: [call("workspace_write", { path: "guard.txt", content: "x" })] },
    ]);
    const loop = new CodingLoop(model);
    const parked = await loop.start({ goal: "Write a file" });

    await expect(
      loop.resumeAfterApproval(parked.id, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toThrow("Agent run is not waiting for this approval");
  });

  test("the step budget ends the run instead of hanging", async () => {
    // Every step asks to inspect again, so the phase never reaches review.
    const provider: ProviderClient = {
      async generate() {
        return { message: "Still looking.", toolCalls: [call("workspace_list", {})] };
      },
    };
    const loop = new CodingLoop(provider, { maxSteps: 3 });

    const run = await loop.start({ goal: "Never finishes" });

    expect(run.status).toBe("failed");
    expect(run.error).toBe("Step budget exhausted before validation passed");
    expect(run.toolCalls).toHaveLength(3);
    expect((await agentRunStore.get(run.id))?.status).toBe("failed");
  });
});
