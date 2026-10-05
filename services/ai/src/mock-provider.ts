import type { ProviderClient, ProviderResponse } from "./provider";

export class DevelopmentProvider implements ProviderClient {
  async generate(input: Parameters<ProviderClient["generate"]>[0]): Promise<ProviderResponse> {
    const lastMessage = input.messages.at(-1)?.content ?? "";
    return { message: `FROSH is online. I received: ${lastMessage}`, toolCalls: [] };
  }
}
