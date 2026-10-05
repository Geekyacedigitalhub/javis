import type { JavisMessage, JavisToolCall } from "../../../packages/types/src/javis";
import { listTools } from "../../tools/src";

export interface ModelAdapter {
  generate(input: {
    messages: JavisMessage[];
    tools: ReturnType<typeof listTools>;
  }): Promise<{
    message: string;
    toolCalls?: JavisToolCall[];
  }>;
}

export class JavisOrchestrator {
  constructor(private readonly model: ModelAdapter) {}

  async respond(messages: JavisMessage[]) {
    const result = await this.model.generate({
      messages,
      tools: listTools(),
    });

    return {
      message: result.message,
      toolCalls: result.toolCalls ?? [],
    };
  }
}
