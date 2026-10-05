import type { JavisMessage, JavisToolCall } from "../../../packages/types/src/javis";
import { listTools } from "../../tools/src";

const SYSTEM_PROMPT = [
  "You are JARVIS, a personal AI assistant.",
  "Be concise, useful, and honest about what you can actually do.",
  "Never claim an action was completed unless a tool actually completed it.",
  "Tool permissions are enforced by the application, not by the model.",
].join(" ");

export function buildModelInput(messages: JavisMessage[]) {
  return {
    system: SYSTEM_PROMPT,
    messages,
    tools: listTools(),
  };
}

export interface ProviderResponse {
  message: string;
  toolCalls?: JavisToolCall[];
}

export interface ProviderClient {
  generate(input: ReturnType<typeof buildModelInput>): Promise<ProviderResponse>;
}

export class ConfiguredModelAdapter {
  constructor(private readonly client: ProviderClient) {}

  generate(input: Parameters<ProviderClient["generate"]>[0]) {
    return this.client.generate(input);
  }
}
