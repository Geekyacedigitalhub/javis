export type JavisRole = "user" | "assistant" | "system" | "tool";

export interface JavisMessage {
  role: JavisRole;
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface JavisRequest {
  message: string;
  conversationId?: string;
  userId?: string;
}

export interface JavisResponse {
  conversationId: string;
  message: string;
  toolCalls: JavisToolCall[];
}

export interface JavisToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: "planned" | "completed" | "failed";
}

export interface JavisToolDefinition {
  name: string;
  description: string;
  permission: "safe" | "confirm" | "restricted";
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}
