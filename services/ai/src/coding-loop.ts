import type { FroshToolCall } from "../../../packages/types/src/javis";
import type { FroshAgentRun } from "../../../packages/types/src/agent-run";
import { approvalStore, executeToolCall, listTools, resolveApproval } from "../../tools/src";
import type { ProviderClient } from "./provider";
import { agentRunStore } from "./coding-session";

/**
 * The autonomous coding loop.
 *
 * The roadmap asks for PLAN -> INSPECT -> IMPLEMENT -> TEST -> DIAGNOSE -> FIX ->
 * TEST -> REVIEW -> COMPLETE, and for one rule that outranks all of it: FROSH
 * must never claim a change is tested, committed, or successful without tool
 * evidence.
 *
 * `CodingSessionManager` makes a single provider call and stores whatever came
 * back, so a model that announces "done, tests pass" is recorded as done. This
 * loop exists to make that claim checkable. It executes tools itself, feeds the
 * results back, and will not finish until a validation tool has actually exited
 * zero.
 *
 * Two properties are deliberate:
 *
 * 1. Phase is derived from the recorded tool calls, not held in memory. A run
 *    that survives a restart re-enters at the right phase, and the reason the
 *    loop thinks it is in that phase is inspectable by anyone reading the run.
 * 2. Approval parking is not a special case bolted on. A `confirm` tool stops
 *    the loop where it stopped, the run parks in `waiting_approval` with the
 *    approval id, and approving it resumes from the recorded evidence.
 */

export type FroshCodingPhase = "plan" | "inspect" | "test" | "fix" | "review";

/** Tools that change the workspace. */
const EDIT_TOOLS = new Set(["workspace_write"]);

/** Tools whose exit code is evidence that the change works. */
const VALIDATION_TOOLS = new Set(["workspace_validate"]);

const PHASE_INSTRUCTIONS: Record<FroshCodingPhase, string> = {
  plan: "Start by understanding the task and inspecting the workspace before you change anything.",
  inspect: "You have looked around but changed nothing yet. Make the smallest correct change.",
  test: "The workspace has changed and nothing has been validated since. Run a real validation command and report what it actually did.",
  fix: "The last validation failed. Read that failure, correct the cause, and do not describe the work as finished.",
  review: "Validation passed. State what changed and what proved it, or inspect the diff first if you need to.",
};

function resultRecord(call: FroshToolCall): Record<string, unknown> | null {
  const value = call.result;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/**
 * A validation call only counts as evidence if the command actually ran to a
 * verdict. A call that never completed, or one whose result carries no exit
 * code, proves nothing.
 */
function validationExitCode(call: FroshToolCall): number | null {
  if (!VALIDATION_TOOLS.has(call.name) || call.status !== "completed") return null;
  const code = resultRecord(call)?.exitCode;
  return typeof code === "number" ? code : null;
}

export function deriveCodingPhase(toolCalls: FroshToolCall[]): FroshCodingPhase {
  if (toolCalls.length === 0) return "plan";

  let lastValidationIndex = -1;
  let lastValidationExit: number | null = null;
  let lastEditIndex = -1;

  toolCalls.forEach((call, index) => {
    if (EDIT_TOOLS.has(call.name) && call.status === "completed") lastEditIndex = index;
    const exitCode = validationExitCode(call);
    if (exitCode !== null) {
      lastValidationIndex = index;
      lastValidationExit = exitCode;
    }
  });

  if (lastEditIndex === -1 && lastValidationIndex === -1) return "inspect";
  if (lastValidationIndex === -1) return "test";
  if (lastValidationExit === 0) return "review";
  // A failure nothing has answered still needs fixing. A failure that has been
  // answered needs testing again, not another blind fix.
  return lastEditIndex > lastValidationIndex ? "test" : "fix";
}

export interface CodingEvidence {
  edits: number;
  validations: number;
  lastValidation?: { command: string; exitCode: number };
}

export function collectCodingEvidence(toolCalls: FroshToolCall[]): CodingEvidence {
  const edits = toolCalls.filter((call) => EDIT_TOOLS.has(call.name) && call.status === "completed").length;
  const validationCalls = toolCalls.filter((call) => validationExitCode(call) !== null);
  const last = validationCalls.at(-1);
  const exitCode = last ? validationExitCode(last) : null;

  return {
    edits,
    validations: validationCalls.length,
    lastValidation:
      last && exitCode !== null ? { command: String(last.arguments.command ?? ""), exitCode } : undefined,
  };
}

function summarizeCalls(toolCalls: FroshToolCall[]): string {
  if (toolCalls.length === 0) return "Nothing has been run yet.";
  return toolCalls
    .map((call) => {
      const args = JSON.stringify(call.arguments);
      const output = JSON.stringify(call.result ?? null);
      return `- ${call.name}(${args.length > 200 ? `${args.slice(0, 200)}…` : args}) [${call.status}] -> ${
        output.length > 600 ? `${output.slice(0, 600)}…` : output
      }`;
    })
    .join("\n");
}

function describeEvidence(evidence: CodingEvidence): string {
  const parts: string[] = [];
  if (evidence.edits > 0) parts.push(`${evidence.edits} edit${evidence.edits === 1 ? "" : "s"} applied`);
  if (evidence.lastValidation) {
    parts.push(`\`${evidence.lastValidation.command}\` exited ${evidence.lastValidation.exitCode}`);
  }
  return parts.length > 0 ? parts.join("; ") : "no evidence recorded";
}

const CODING_LOOP_SYSTEM = [
  "You are FROSH's autonomous coding agent, working in a loop.",
  "Inspect before changing anything.",
  "Use safe tools directly; sensitive actions are escalated for approval automatically.",
  "After changing the workspace, validate with the project's real test, typecheck, lint, or build command.",
  "If validation fails, diagnose the actual output and correct the cause.",
  "Never claim something is tested, fixed, or working unless a validation tool actually reported it.",
].join(" ");

export class CodingLoop {
  constructor(
    private readonly model: ProviderClient,
    private readonly options: { maxSteps?: number; maxCorrections?: number } = {},
  ) {}

  private get maxSteps() {
    return this.options.maxSteps ?? 8;
  }

  private get maxCorrections() {
    return this.options.maxCorrections ?? 1;
  }

  async start(input: { goal: string; conversationId?: string }) {
    const goal = input.goal.trim();
    if (!goal) throw new Error("A coding goal is required to start the loop");

    const run = await agentRunStore.create({
      conversationId: input.conversationId,
      goal,
      status: "running",
      toolCalls: [],
    });

    return this.drive(run.id);
  }

  /**
   * Resume a run that parked on an approval. The approval has already been
   * accepted, so the approved tool runs exactly once here and its real output
   * becomes the evidence the next phase is derived from.
   */
  async resumeAfterApproval(runId: string, approvalId: string) {
    const run = await agentRunStore.get(runId);
    if (!run) throw new Error("Agent run not found");
    if (run.status !== "waiting_approval" || run.pendingApprovalId !== approvalId) {
      throw new Error("Agent run is not waiting for this approval");
    }

    const approval = await approvalStore.get(approvalId);
    if (!approval) throw new Error("Approval request not found");
    // Still pending on purpose: resolving it below is what records the decision
    // and performs the action, in that order, exactly once.
    if (approval.status !== "pending") throw new Error("Approval is no longer pending");

    let result: unknown;
    try {
      result = (await resolveApproval(approvalId, "approved")).result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Approved action failed";
      await agentRunStore.update(runId, {
        status: "failed",
        pendingApprovalId: undefined,
        toolCalls: [
          ...run.toolCalls,
          {
            id: approvalId,
            name: approval.toolName,
            arguments: approval.arguments,
            status: "failed",
            result: { error: message },
          },
        ],
        result: "The approved action failed, so the loop stopped rather than continue on a broken workspace.",
        error: message,
      });
      throw error;
    }

    await agentRunStore.update(runId, {
      status: "running",
      pendingApprovalId: undefined,
      toolCalls: [
        ...run.toolCalls,
        { id: approvalId, name: approval.toolName, arguments: approval.arguments, status: "completed", result },
      ],
    });

    return this.drive(runId);
  }

  /** Stop a parked run because the user refused the action. */
  async reject(approvalId: string) {
    const approval = await approvalStore.get(approvalId);
    if (!approval?.runId) throw new Error("Approval is not attached to an agent run");

    const run = await agentRunStore.get(approval.runId);
    if (!run) throw new Error("Agent run not found");
    if (run.status !== "waiting_approval" || run.pendingApprovalId !== approvalId) {
      throw new Error("Agent run is not waiting for this approval");
    }

    await resolveApproval(approvalId, "rejected");
    return agentRunStore.update(run.id, {
      status: "failed",
      pendingApprovalId: undefined,
      result: "The requested action was rejected by the user, so the loop stopped.",
      error: "User rejected approval",
    });
  }

  private async drive(runId: string): Promise<FroshAgentRun> {
    let corrections = 0;

    for (let step = 0; step < this.maxSteps; step += 1) {
      const run = await agentRunStore.get(runId);
      if (!run) throw new Error("Agent run not found");
      if (run.status === "completed" || run.status === "failed") return run;

      const phase = deriveCodingPhase(run.toolCalls);
      const evidence = collectCodingEvidence(run.toolCalls);

      let response;
      try {
        response = await this.model.generate({
          system: CODING_LOOP_SYSTEM,
          messages: [
            { role: "user", content: run.goal },
            {
              role: "user",
              content: [
                `Phase: ${phase}.`,
                PHASE_INSTRUCTIONS[phase],
                "",
                "Work so far:",
                summarizeCalls(run.toolCalls),
                "",
                `Evidence: ${describeEvidence(evidence)}.`,
                ...(corrections > 0
                  ? ["", "A previous reply claimed completion without a validation result. Do not repeat that; run the validation command."]
                  : []),
              ].join("\n"),
            },
          ],
          tools: listTools(),
        });
      } catch (error) {
        return agentRunStore.update(runId, {
          status: "failed",
          error: error instanceof Error ? error.message : "Provider failed",
          result: "The coding loop stopped because the model could not be reached.",
        });
      }

      const requested = response.toolCalls ?? [];
      const executed: FroshToolCall[] = [];

      for (const call of requested) {
        const outcome = await executeToolCall(call, { runId });
        const outcomeResult = resultRecord(outcome);

        // A tool needing approval parks the whole loop. Nothing is recorded for
        // it yet, so the evidence stays honest until the action really happens.
        if (outcome.status === "failed" && typeof outcomeResult?.approvalId === "string") {
          const parked = await agentRunStore.update(runId, {
            status: "waiting_approval",
            pendingApprovalId: outcomeResult.approvalId,
            toolCalls: [...run.toolCalls, ...executed],
          });
          if (!response.message?.trim()) return parked;
          return agentRunStore.update(runId, { result: response.message.trim() });
        }

        executed.push(outcome);
      }

      const allCalls = [...run.toolCalls, ...executed];
      const nextPhase = deriveCodingPhase(allCalls);
      const nextEvidence = collectCodingEvidence(allCalls);

      // The gate. A step that asks for no tools is the model declaring it is
      // done, and that declaration is only accepted on real validation output.
      if (requested.length === 0) {
        if (nextPhase === "review") {
          return agentRunStore.update(runId, {
            status: "completed",
            toolCalls: allCalls,
            pendingApprovalId: undefined,
            providerContinuation: undefined,
            result: `${response.message?.trim() || "Coding goal complete."}\n\nVerified: ${describeEvidence(nextEvidence)}.`,
          });
        }

        if (corrections >= this.maxCorrections) {
          return agentRunStore.update(runId, {
            status: "failed",
            toolCalls: allCalls,
            error: "Model reported completion without validation evidence",
            result: `FROSH stopped without claiming success: nothing ever validated the work, so there is no proof it is correct. Last statement: ${response.message?.trim() || "(none)"}`,
          });
        }

        corrections += 1;
        await agentRunStore.update(runId, { toolCalls: allCalls });
        continue;
      }

      await agentRunStore.update(runId, { toolCalls: allCalls });
    }

    const exhausted = await agentRunStore.get(runId);
    const toolCalls = exhausted?.toolCalls ?? [];
    const evidence = collectCodingEvidence(toolCalls);
    const complete = deriveCodingPhase(toolCalls) === "review";

    return agentRunStore.update(runId, {
      status: complete ? "completed" : "failed",
      error: complete ? undefined : "Step budget exhausted before validation passed",
      result: complete
        ? `FROSH reached the step limit after validation passed. Verified: ${describeEvidence(evidence)}.`
        : `FROSH used all ${this.maxSteps} steps without a passing validation. Evidence so far: ${describeEvidence(evidence)}.`,
    });
  }
}
