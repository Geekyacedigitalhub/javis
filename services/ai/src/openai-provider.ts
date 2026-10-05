import OpenAI from "openai";
import type { FroshToolCall } from "../../../packages/types/src/javis";
import { buildModelInput } from "./provider";
import { executeToolCall } from "../../tools/src";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model = process.env.FROSH_MODEL || "gpt-6-luna";
const MAX_TOOL_ROUNDS = 8;

export class OpenAIProvider {
  async generate(input: ReturnType<typeof buildModelInput>) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not configured");
    }

    const tools = input.tools.map((tool) => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      strict: true,
    }));

    const items: any[] = input.messages.map((message) => ({
      role: message.role === "tool" ? "user" : message.role,
      content: message.content,
    }));

    const executedCalls: FroshToolCall[] = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await client.responses.create({
        model,
        instructions: input.system,
        input: items,
        tools: tools as any,
      });

      const calls = (response.output as any[]).filter(
        (item) => item.type === "function_call",
      );

      if (!calls.length) {
        return {
          message: response.output_text ?? "",
          toolCalls: executedCalls,
        };
      }

      for (const item of response.output as any[]) {
        items.push(item);
      }

      for (const item of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(item.arguments || "{}");
        } catch {
          args = {};
        }

        const planned: FroshToolCall = {
          id: item.call_id ?? item.id,
          name: item.name,
          arguments: args,
          status: "planned",
        };

        const result = await executeToolCall(planned);
        executedCalls.push(result);

        items.push({
          type: "function_call_output",
          call_id: item.call_id ?? item.id,
          output: JSON.stringify(result),
        });
      }
    }

    return {
      message: "FROSH reached the maximum tool-execution rounds for this request.",
      toolCalls: executedCalls,
    };
  }
}
