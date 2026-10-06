import type { FroshMessage, FroshToolCall } from "../../../packages/types/src/javis";
import { listTools, approvalStore, resolveApproval } from "../../tools/src";
import type { ProviderClient } from "./provider";
import { createAgentRunStore } from "./run-store-factory";
import { broadcast } from "../../api/src/realtime";

export const agentRunStore = createAgentRunStore();

const CODING_SYSTEM = [
  "You are FROSH's coding agent.",
  "Inspect before changing.",
  "Use safe tools automatically.",
  "Sensitive actions require explicit user approval.",
  "After approved changes, validate with tests, typecheck, lint, or build.",
  "If validation fails, diagnose and propose the next correction.",
  "Never claim success without tool evidence.",
].join(" ");

export class CodingSessionManager {
  constructor(private readonly model: ProviderClient) {}

  async start(input: { goal: string; messages: FroshMessage[]; conversationId?: string; onRunCreated?: (run: Awaited<ReturnType<typeof agentRunStore.create>>) => Promise<void>; canPersist?: () => Promise<boolean> }) {
    const run = await agentRunStore.create({
      conversationId: input.conversationId,
      goal: input.goal,
      status: "running",
      toolCalls: [],
    });
    try {
      if (input.onRunCreated) await input.onRunCreated(run);
      return await this.step(run.id, input.messages, input.canPersist);
    } catch (error) {
      try {
        if (!input.canPersist || await input.canPersist()) {
          await agentRunStore.update(run.id, {
            status: "failed",
            error: error instanceof Error ? error.message : "Agent run failed before provider execution",
            result: "The run was stopped before provider execution could begin.",
          });
        }
      } catch {}
      throw error;
    }
  }

  async step(runId: string, messages: FroshMessage[], canPersist?: () => Promise<boolean>) {
    const run = await agentRunStore.get(runId);
    if (!run) throw new Error("Agent run not found");
    if (run.status === "completed" || run.status === "failed") return run;

    const result = await this.model.generate(
      { system: CODING_SYSTEM, messages, tools: listTools() },
      { runId, continuation: run.providerContinuation ? { continuation: run.providerContinuation } : undefined },
    );

    const calls: FroshToolCall[] = [...run.toolCalls, ...(result.toolCalls ?? [])];

    if (result.waitingForApproval && result.continuation) {
      const approvalCall = calls[calls.length - 1];
      const approvalId =
        typeof approvalCall?.result === "object" && approvalCall.result !== null && "approvalId" in approvalCall.result
          ? String((approvalCall.result as { approvalId: unknown }).approvalId)
          : undefined;
      if (!approvalId) throw new Error("Provider paused without an approval request");

      if (canPersist && !(await canPersist())) return agentRunStore.get(runId).then((current) => current ?? run);

      if (canPersist && !(await canPersist())) return agentRunStore.get(runId).then((current) => current ?? run);

    return agentRunStore.update(runId, {
        status: "waiting_approval",
        pendingApprovalId: approvalId,
        providerContinuation: result.continuation,
        toolCalls: calls,
        result: result.message,
      });
    }

    return agentRunStore.update(runId, {
      status: "completed",
      toolCalls: calls,
      result: result.message,
      pendingApprovalId: undefined,
      providerContinuation: undefined,
    });
  }

  async approveAndResume(approvalId: string) {
    const approval = await approvalStore.get(approvalId);
    if (!approval) throw new Error("Approval request not found");
    if (!approval.runId) throw new Error("Approval is not attached to an agent run");

    const run = await agentRunStore.get(approval.runId);
    if (!run) throw new Error("Agent run not found");
    if (run.status !== "waiting_approval" || run.pendingApprovalId !== approvalId) {
      throw new Error("Agent run is not waiting for this approval");
    }
    if (!run.providerContinuation?.pendingCallId) {
      throw new Error("Agent run has no resumable provider state");
    }

    const resolved = await resolveApproval(approvalId, "approved");
    const toolCall: FroshToolCall = {
      id: `approved-${approvalId}`,
      name: approval.toolName,
      arguments: approval.arguments,
      status: "completed",
      result: resolved.result,
    };

    await agentRunStore.update(run.id, {
      status: "running",
      pendingApprovalId: undefined,
      toolCalls: [...run.toolCalls, toolCall],
    });

    let resumed;
    try {
      resumed = await this.model.generate(
        { system: CODING_SYSTEM, messages: [], tools: listTools() },
        {
        runId: run.id,
        continuation: {
          continuation: run.providerContinuation,
          toolOutput: {
            callId: run.providerContinuation.pendingCallId,
            output: JSON.stringify(resolved.result),
          },
        },
        },
      );
    } catch (error) {
      await agentRunStore.update(run.id, {
        status: "failed",
        pendingApprovalId: undefined,
        providerContinuation: run.providerContinuation,
        result: "Approval was accepted, but FROSH could not resume the provider session. The run was stopped safely.",
        error: error instanceof Error ? error.message : "Provider continuation failed",
      });
      throw error;
    }

    const calls = [...run.toolCalls, toolCall, ...(resumed.toolCalls ?? [])];

    if (resumed.waitingForApproval && resumed.continuation) {
      const approvalCall = calls[calls.length - 1];
      const nextApprovalId =
        typeof approvalCall?.result === "object" && approvalCall.result !== null && "approvalId" in approvalCall.result
          ? String((approvalCall.result as { approvalId: unknown }).approvalId)
          : undefined;
      if (!nextApprovalId) throw new Error("Provider paused without an approval request");

      return agentRunStore.update(run.id, {
        status: "waiting_approval",
        pendingApprovalId: nextApprovalId,
        providerContinuation: resumed.continuation,
        toolCalls: calls,
        result: resumed.message,
      });
    }

    return agentRunStore.update(run.id, {
      status: "completed",
      pendingApprovalId: undefined,
      providerContinuation: undefined,
      toolCalls: calls,
      result: resumed.message,
    });
  }

  async reject(approvalId: string) {
    const approval = await approvalStore.get(approvalId);
    if (!approval) throw new Error("Approval request not found");
    if (!approval.runId) throw new Error("Approval is not attached to an agent run");

    await resolveApproval(approvalId, "rejected");
    const run = await agentRunStore.get(approval.runId);
    if (!run) throw new Error("Agent run not found");

    return agentRunStore.update(run.id, {
      status: "failed",
      pendingApprovalId: undefined,
      providerContinuation: undefined,
      result: "The requested action was rejected by the user.",
      error: "User rejected approval",
    });
  }
}
