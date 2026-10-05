import OpenAI from "openai";
import type { FroshToolCall } from "../../../packages/types/src/javis";
import type { FroshProviderContinuation } from "../../../packages/types/src/agent-run";
import { buildModelInput } from "./provider";
import { executeToolCall } from "../../tools/src";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model = process.env.FROSH_MODEL || "gpt-6-luna";
const MAX_TOOL_ROUNDS = 8;

type GenerateOptions = {
  runId?: string;
  continuation?: {
    continuation: FroshProviderContinuation;
    toolOutput?: {
      callId: string;
      output: string;
    };
  };
};



export type FroshStreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; status: "planned" | "completed" | "failed"; toolCallId?: string }
  | { type: "approval"; approvalId?: string }
  | { type: "done"; message: string; toolCalls: FroshToolCall[] };

type StreamOptions = GenerateOptions;

export class OpenAIProvider {
  async *stream(
    input: ReturnType<typeof buildModelInput>,
    options: StreamOptions = {},
  ): AsyncGenerator<FroshStreamEvent> {
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

    let previousResponseId: string | undefined = options.continuation?.continuation.responseId;
    let continuationInput: any[] = options.continuation
      ? [
          ...(options.continuation.continuation.pendingToolOutputs ?? []).map((output) => ({
            type: "function_call_output",
            call_id: output.callId,
            output: output.output,
          })),
        ]
      : input.messages.map((message) => ({
          role: message.role === "tool" ? "user" : message.role,
          content: message.content,
        }));

    if (options.continuation?.toolOutput) {
      continuationInput.push({
        type: "function_call_output",
        call_id: options.continuation.toolOutput.callId,
        output: options.continuation.toolOutput.output,
      });
    }

    const executedCalls: FroshToolCall[] = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const stream = await client.responses.create({
        model,
        instructions: input.system,
        input: continuationInput,
        previous_response_id: previousResponseId,
        tools: tools as any,
        store: true,
        stream: true,
      });

      let text = "";
      let completedResponse: any;

      for await (const event of stream as any) {
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          text += event.delta;
          yield { type: "delta", text: event.delta };
        }
        if (event.type === "response.completed") {
          completedResponse = event.response;
        }
      }

      if (!completedResponse) {
        throw new Error("OpenAI stream ended without a completed response");
      }

      previousResponseId = completedResponse.id;
      const calls = (completedResponse.output as any[]).filter(
        (item) => item.type === "function_call",
      );

      if (!calls.length) {
        yield { type: "done", message: text || completedResponse.output_text || "", toolCalls: executedCalls };
        return;
      }

      continuationInput = [];

      for (const item of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(item.arguments || "{}");
        } catch {
          args = {};
        }

        const callId = item.call_id ?? item.id;
        const planned: FroshToolCall = {
          id: callId,
          name: item.name,
          arguments: args,
          status: "planned",
        };

        yield { type: "tool", name: item.name, status: "planned", toolCallId: callId };

        const result = await executeToolCall(planned, { runId: options.runId });
        executedCalls.push(result);

        yield {
          type: "tool",
          name: item.name,
          status: result.status === "completed" ? "completed" : "failed",
          toolCallId: callId,
        };

        const resultValue = result.result;
        const approvalId =
          typeof resultValue === "object" &&
          resultValue !== null &&
          "approvalId" in resultValue
            ? String((resultValue as { approvalId: unknown }).approvalId)
            : undefined;

        if (approvalId) {
          yield { type: "approval", approvalId };
          yield {
            type: "done",
            message: "FROSH is waiting for your approval before continuing.",
            toolCalls: executedCalls,
          };
          return;
        }

        continuationInput.push({
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(result),
        });
      }
    }

    const message = "FROSH reached the maximum tool-execution rounds for this request.";
    yield { type: "delta", text: message };
    yield { type: "done", message, toolCalls: executedCalls };
  }

  async generate(input: ReturnType<typeof buildModelInput>, options: GenerateOptions = {}) {
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

    const executedCalls: FroshToolCall[] = [];
    let previousResponseId: string | undefined;
    let continuationInput: any[] | undefined;

    if (options.continuation) {
      previousResponseId = options.continuation.continuation.responseId;
      continuationInput = [
        ...(options.continuation.continuation.pendingToolOutputs ?? []).map((output) => ({
          type: "function_call_output",
          call_id: output.callId,
          output: output.output,
        })),
      ];
      if (options.continuation.toolOutput) {
        continuationInput.push({
          type: "function_call_output",
          call_id: options.continuation.toolOutput.callId,
          output: options.continuation.toolOutput.output,
        });
      }
    } else {
      continuationInput = input.messages.map((message) => ({
        role: message.role === "tool" ? "user" : message.role,
        content: message.content,
      }));
    }

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await client.responses.create({
        model,
        instructions: input.system,
        input: continuationInput ?? [],
        previous_response_id: previousResponseId,
        tools: tools as any,
        store: true,
      });

      previousResponseId = response.id;
      continuationInput = [];

      const calls = (response.output as any[]).filter(
        (item) => item.type === "function_call",
      );

      if (!calls.length) {
        return {
          message: response.output_text ?? "",
          toolCalls: executedCalls,
        };
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

        const result = await executeToolCall(planned, { runId: options.runId });
        executedCalls.push(result);

        const resultValue = result.result;
        const approvalId =
          typeof resultValue === "object" &&
          resultValue !== null &&
          "approvalId" in resultValue
            ? String((resultValue as { approvalId: unknown }).approvalId)
            : undefined;

        if (approvalId) {
          return {
            message: "FROSH is waiting for your approval before continuing.",
            toolCalls: executedCalls,
            waitingForApproval: true,
            continuation: {
              provider: "openai",
              responseId: response.id,
              pendingCallId: item.call_id ?? item.id,
              pendingToolName: item.name,
              pendingToolOutputs: continuationInput.map((output: any) => ({
                callId: output.call_id,
                output: output.output,
              })),
            },
          };
        }

        continuationInput.push({
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
