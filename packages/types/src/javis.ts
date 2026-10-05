export type FroshRole = "user" | "assistant" | "system" | "tool";
export type JavisRole = FroshRole;

export interface FroshMessage {
  role: FroshRole;
  content: string;
  name?: string;
  toolCallId?: string;
}
export type JavisMessage = FroshMessage;

export interface FroshRequest {
  message: string;
  conversationId?: string;
  userId?: string;
}
export type JavisRequest = FroshRequest;

export interface FroshToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: "planned" | "completed" | "failed";
}
export type JavisToolCall = FroshToolCall;

export interface FroshToolDefinition {
  name: string;
  description: string;
  permission: "safe" | "confirm" | "restricted";
  parameters?: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}
export type JavisToolDefinition = FroshToolDefinition;

export interface FroshResponse {
  conversationId: string;
  message: string;
  toolCalls: FroshToolCall[];
}
export type JavisResponse = FroshResponse;
