import type { FroshMessage, FroshToolCall } from "../../../packages/types/src/javis";
import type { FroshProviderContinuation } from "../../../packages/types/src/agent-run";
import { listTools } from "../../tools/src";

const SYSTEM_PROMPT = [
  "You are FROSH, a powerful personal AI operating system.",
  "Be concise, useful, and honest about what you can actually do.",
  "You can assist with software development, cybersecurity, research, business, career work, and automation.",
  "Never claim an action was completed unless the application actually executed it.",
  "Tool permissions are enforced by the application, not by the model.",
].join(" ");

export function buildModelInput(messages: FroshMessage[]) {
  return { system: SYSTEM_PROMPT, messages, tools: listTools() };
}

export interface ProviderContinuationInput {
  continuation: FroshProviderContinuation;
  toolOutput?: {
    callId: string;
    output: string;
  };
  toolOutputs?: Array<{ callId: string; output: string }>;
}

export interface ProviderResponse {
  message: string;
  toolCalls?: FroshToolCall[];
  continuation?: FroshProviderContinuation;
  waitingForApproval?: boolean;
}

export interface ProviderClient {
  generate(
    input: ReturnType<typeof buildModelInput>,
    options?: { runId?: string; continuation?: ProviderContinuationInput },
  ): Promise<ProviderResponse>;
}

export class ConfiguredModelAdapter {
  constructor(private readonly client: ProviderClient) {}
  generate(
    input: Parameters<ProviderClient["generate"]>[0],
    options?: Parameters<ProviderClient["generate"]>[1],
  ) {
    return this.client.generate(input, options);
  }
}
