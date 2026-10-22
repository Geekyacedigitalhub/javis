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
  result?: unknown;
  durationMs?: number;
}
export type JavisToolCall = FroshToolCall;

export interface FroshToolDefinition {
  name: string;
  description: string;
  permission: "safe" | "confirm" | "restricted";
  parameters?: Record<string, unknown>;
  /**
   * Rejects arguments that can never succeed, before anything is asked of the
   * user. Without this, a malformed request becomes an approval prompt that
   * cannot be honoured however the user answers it.
   */
  validate?: (args: Record<string, unknown>) => string | null;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}
export type JavisToolDefinition = FroshToolDefinition;

export interface FroshResponse {
  conversationId: string;
  message: string;
  toolCalls: FroshToolCall[];
}
export type JavisResponse = FroshResponse;
