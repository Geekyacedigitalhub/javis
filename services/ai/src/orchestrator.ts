import type { FroshMessage, FroshToolCall } from "../../../packages/types/src/javis";
import { executeToolCall, listTools } from "../../tools/src";
import type { ModelAdapter } from "./provider";

export class FroshOrchestrator {
  constructor(private readonly model: ModelAdapter) {}

  async respond(messages: FroshMessage[]) {
    const result = await this.model.generate({ messages, tools: listTools() });
    const toolCalls: FroshToolCall[] = [];

    for (const call of result.toolCalls ?? []) {
      toolCalls.push(
        call.status === "planned" ? await executeToolCall(call) : call,
      );
    }

    return {
      message: result.message,
      toolCalls,
    };
  }
}

export { FroshOrchestrator as JavisOrchestrator };
