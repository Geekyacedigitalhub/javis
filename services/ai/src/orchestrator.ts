import type { FroshMessage, FroshToolCall } from "../../../packages/types/src/javis";
import { executeToolCall, listTools } from "../../tools/src";
import { buildModelInput } from "./provider";
import type { ConfiguredModelAdapter } from "./provider";

export class FroshOrchestrator {
  constructor(private readonly model: ConfiguredModelAdapter) {}

  async respond(messages: FroshMessage[]) {
    const result = await this.model.generate(buildModelInput(messages));
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
