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

export interface ProviderGenerateOptions {
  runId?: string;
  continuation?: ProviderContinuationInput;
}

export interface ProviderResponse {
  message: string;
  toolCalls?: FroshToolCall[];
  continuation?: FroshProviderContinuation;
  waitingForApproval?: boolean;
}

export type FroshStreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; status: "planned" | "completed" | "failed"; toolCallId?: string }
  | { type: "approval"; approvalId?: string }
  | { type: "done"; message: string; toolCalls: FroshToolCall[]; conversationId?: string };

export interface ProviderClient {
  generate(
    input: ReturnType<typeof buildModelInput>,
    options?: ProviderGenerateOptions,
  ): Promise<ProviderResponse>;
}

/** A model adapter can opt into the chat endpoint's event protocol. */
export interface StreamingProviderClient extends ProviderClient {
  stream(
    input: ReturnType<typeof buildModelInput>,
    options?: ProviderGenerateOptions,
  ): AsyncGenerator<FroshStreamEvent>;
}

export interface MissionEvaluation {
  complete: boolean;
  nextAction: "continue" | "recover" | "finish";
  reason: string;
  nextStep?: string;
}

export interface MissionEvaluatingProvider extends ProviderClient {
  evaluateMission(input: { goal: string; step: string; result: string }): Promise<MissionEvaluation>;
}

export function isStreamingProvider(provider: ProviderClient): provider is StreamingProviderClient {
  return typeof (provider as Partial<StreamingProviderClient>).stream === "function";
}

export function isMissionEvaluatingProvider(provider: ProviderClient): provider is MissionEvaluatingProvider {
  return typeof (provider as Partial<MissionEvaluatingProvider>).evaluateMission === "function";
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
