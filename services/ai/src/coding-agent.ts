import type { FroshMessage, FroshToolCall } from "../../../packages/types/src/javis";
import { executeToolCall, listTools } from "../../tools/src";
import type { ProviderClient } from "./provider";

export interface CodingTaskResult {
  message: string;
  toolCalls: FroshToolCall[];
  requiresApproval: boolean;
}

export class CodingAgent {
  constructor(private readonly model: ProviderClient) {}

  async run(messages: FroshMessage[]): Promise<CodingTaskResult> {
    const input = {
      system: [
        "You are FROSH's coding agent.",
        "First inspect the repository and relevant files before changing code.",
        "Use safe read and analysis tools automatically.",
        "Never claim code was changed, tested, committed, or deployed unless a tool actually completed it.",
        "Changes, command execution, branches, commits, and external GitHub mutations require approval.",
        "When validation fails, inspect the failure and make another proposed correction instead of pretending success.",
      ].join(" "),
      messages,
      tools: listTools(),
    };

    const result = await this.model.generate(input);
    const toolCalls: FroshToolCall[] = [];
    let requiresApproval = false;

    for (const call of result.toolCalls ?? []) {
      const executed = await executeToolCall(call);
      toolCalls.push(executed);

      const resultValue = executed.result;
      if (
        executed.status === "failed" &&
        typeof resultValue === "object" &&
        resultValue !== null &&
        "approvalId" in resultValue
      ) {
        requiresApproval = true;
      }
    }

    return { message: result.message, toolCalls, requiresApproval };
  }
}
