import type { ProviderClient, ProviderResponse } from "./provider";

/**
 * Offline-only fallback for tests and local wiring checks. It must never make a
 * deployment look like it has a live AI model: a real assistant requires a
 * configured provider credential.
 */
export class DevelopmentProvider implements ProviderClient {
  async generate(input: Parameters<ProviderClient["generate"]>[0]): Promise<ProviderResponse> {
    const lastMessage = input.messages.at(-1)?.content ?? "";
    return {
      message: [
        "FROSH's live AI brain is not configured yet.",
        "Add GEMINI_API_KEY (free-tier Gemini) or OPENAI_API_KEY to the server environment.",
        lastMessage ? `Your message was received but not sent to a model: ${lastMessage}` : "",
      ].filter(Boolean).join(" "),
      toolCalls: [],
    };
  }
}
