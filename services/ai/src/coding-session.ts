import type { FroshMessage, FroshToolCall } from "../../../packages/types/src/javis";
import { executeToolCall, listTools } from "../../tools/src";
import type { ProviderClient } from "./provider";
import { InMemoryAgentRunStore } from "./run-store";

export const agentRunStore = new InMemoryAgentRunStore();

export class CodingSessionManager {
  constructor(private readonly model: ProviderClient) {}

  async start(input: { goal: string; messages: FroshMessage[]; conversationId?: string }) {
    const run = await agentRunStore.create({
      conversationId: input.conversationId,
      goal: input.goal,
      status: "running",
      toolCalls: [],
    });

    const result = await this.step(run.id, input.messages);
    return result;
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
      const executed = await executeToolCall(call);
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
}
