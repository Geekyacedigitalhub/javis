import type { FroshMessage, FroshToolCall } from "../../../packages/types/src/javis";
import { executeToolCall, listTools } from "../../tools/src";
import { buildModelInput, throwIfProviderAborted } from "./provider";
import type { ConfiguredModelAdapter, ProviderGenerateOptions } from "./provider";

export class FroshOrchestrator {
  constructor(private readonly model: ConfiguredModelAdapter) {}

  async respond(messages: FroshMessage[], options: ProviderGenerateOptions = {}) {
    const result = await this.model.generate(buildModelInput(messages), options);
    const toolCalls: FroshToolCall[] = [];

    for (const call of result.toolCalls ?? []) {
      throwIfProviderAborted(options.signal);
      const completed = call.status === "planned" ? await executeToolCall(call) : call;
      throwIfProviderAborted(options.signal);
      toolCalls.push(completed);
    }

    return {
      message: result.message,
      toolCalls,
    };
  }
}

export { FroshOrchestrator as JavisOrchestrator };
