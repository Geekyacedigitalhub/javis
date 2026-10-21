import type { ProviderClient } from "./provider";
import { OpenAIProvider } from "./openai-provider";
import { DevelopmentProvider } from "./mock-provider";

/**
 * Provider selection stays behind this boundary so services never import a
 * concrete model SDK. Without credentials FROSH runs the offline development
 * provider, which lets the API, tools, missions, and automation layers be
 * exercised locally without network access.
 */
export function createProvider(): ProviderClient {
  return process.env.OPENAI_API_KEY?.trim() ? new OpenAIProvider() : new DevelopmentProvider();
}

export function describeProvider(): "openai" | "development" {
  return process.env.OPENAI_API_KEY?.trim() ? "openai" : "development";
}
