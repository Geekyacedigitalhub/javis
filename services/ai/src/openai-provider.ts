import OpenAI from "openai";
import type { FroshToolCall } from "../../../packages/types/src/javis";
import { buildModelInput } from "./provider";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model = process.env.FROSH_MODEL || "gpt-6-luna";

export class OpenAIProvider {
  async generate(input: ReturnType<typeof buildModelInput>) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not configured");
    }

    const modelInput = input;
    const tools = modelInput.tools.map((tool) => ({
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

    const response = await client.responses.create({
      model,
      instructions: modelInput.system,
      input: modelInput.messages.map((message) => ({
        role: message.role === "tool" ? "user" : message.role,
        content: message.content,
      })),
      tools: tools as any,
    });

    const toolCalls: FroshToolCall[] = [];

    for (const item of response.output as any[]) {
      if (item.type !== "function_call") continue;

      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(item.arguments || "{}");
      } catch {
        args = {};
      }

      toolCalls.push({
        id: item.call_id ?? item.id,
        name: item.name,
        arguments: args,
        status: "planned",
      });
    }

    return {
      message: response.output_text ?? "",
      toolCalls,
    };
  }
}
