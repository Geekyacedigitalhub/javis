import type { FroshMessage, FroshToolCall } from "../../../packages/types/src/javis";
import { executeToolCall, listTools, approvalStore, resolveApproval } from "../../tools/src";
import type { ProviderClient } from "./provider";
import { createAgentRunStore } from "./run-store-factory";

export const agentRunStore = createAgentRunStore();

export class CodingSessionManager {
  constructor(private readonly model: ProviderClient) {}

  async start(input: { goal: string; messages: FroshMessage[]; conversationId?: string }) {
    const run = await agentRunStore.create({
      conversationId: input.conversationId,
      goal: input.goal,
      status: "running",
      toolCalls: [],
    });
    return this.step(run.id, input.messages);
  }

  async step(runId: string, messages: FroshMessage[]) {
    const run = await agentRunStore.get(runId);
    if (!run) throw new Error("Agent run not found");
    if (run.status === "completed" || run.status === "failed") return run;

    const result = await this.model.generate({
      system: [
        "You are FROSH's coding agent.",
        "Inspect before changing.",
        "Use safe tools automatically.",
        "Sensitive actions require explicit user approval.",
        "After approved changes, validate with tests, typecheck, lint, or build.",
        "If validation fails, diagnose and propose the next correction.",
        "Never claim success without tool evidence.",
      ].join(" "),
      messages,
      tools: listTools(),
    });

    const calls: FroshToolCall[] = [...run.toolCalls];

    for (const call of result.toolCalls ?? []) {
      const executed = await executeToolCall(call, { runId });
      calls.push(executed);
      const value = executed.result;
      const approvalId =
        typeof value === "object" && value !== null && "approvalId" in value
          ? String((value as { approvalId: unknown }).approvalId)
          : undefined;

      if (approvalId) {
        return agentRunStore.update(runId, {
          status: "waiting_approval",
          pendingApprovalId: approvalId,
          toolCalls: calls,
          result: result.message,
        });
      }
    }

    return agentRunStore.update(runId, {
      status: "completed",
      toolCalls: calls,
      result: result.message,
      pendingApprovalId: undefined,
    });
  }

  async approveAndResume(approvalId: string, messages: FroshMessage[]) {
    const approval = await approvalStore.get(approvalId);
    if (!approval) throw new Error("Approval request not found");
    if (!approval.runId) throw new Error("Approval is not attached to an agent run");

    const run = await agentRunStore.get(approval.runId);
    if (!run) throw new Error("Agent run not found");
    if (run.status !== "waiting_approval" || run.pendingApprovalId !== approvalId) {
      throw new Error("Agent run is not waiting for this approval");
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

    return this.step(run.id, [
      ...messages,
      {
        role: "tool",
        name: approval.toolName,
        toolCallId: toolCall.id,
        content: JSON.stringify(resolved.result),
      },
    ]);
  }

  async reject(approvalId: string) {
    const approval = await approvalStore.get(approvalId);
    if (!approval) throw new Error("Approval request not found");
    if (!approval.runId) throw new Error("Approval is not attached to an agent run");

    const resolved = await resolveApproval(approvalId, "rejected");
    const run = await agentRunStore.get(approval.runId);
    if (!run) throw new Error("Agent run not found");

    return agentRunStore.update(run.id, {
      status: "failed",
      pendingApprovalId: undefined,
      result: "The requested action was rejected by the user.",
      error: "User rejected approval",
    });
  }
}
