import type { FroshMessage, FroshToolCall } from "../../../packages/types/src/javis";
import { executeToolCall, listTools } from "../../tools/src";
import type { ModelAdapter } from "./provider";

export class FroshOrchestrator {
  constructor(private readonly model: ModelAdapter) {}

  async respond(messages: FroshMessage[]) {
    const result = await this.model.generate({ messages, tools: listTools() });
    const completedCalls: FroshToolCall[] = [];

    for (const call of result.toolCalls ?? []) {
      completedCalls.push(await executeToolCall(call));
    }

    return { message: result.message, toolCalls: completedCalls };
  }
}

export { FroshOrchestrator as JavisOrchestrator };
