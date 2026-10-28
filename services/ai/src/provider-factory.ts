import type { ProviderClient } from "./provider";
import { OpenAIProvider } from "./openai-provider";
import { GeminiProvider } from "./gemini-provider";
import { DevelopmentProvider } from "./mock-provider";

export type FroshAIProviderName = "gemini" | "openai" | "development";

export type FroshAIProviderStatus = {
  provider: FroshAIProviderName;
  configured: boolean;
  model?: string;
  message: string;
};

type Environment = Record<string, string | undefined>;

function requestedProvider(env: Environment): FroshAIProviderName | undefined {
  const requested = env.FROSH_AI_PROVIDER?.trim().toLowerCase();
  if (!requested) return undefined;
  if (requested === "gemini" || requested === "openai" || requested === "development") return requested;
  return undefined;
}

/**
 * Select a real model when one is configured. Gemini is a first-class option
 * because its free tier lets a personal deployment become genuinely useful
 * without requiring an OpenAI subscription. The development provider is kept
 * only for local/offline testing and advertises its limitation to callers.
 */
export function describeProvider(env: Environment = process.env): FroshAIProviderStatus {
  const requested = requestedProvider(env);
  const geminiConfigured = Boolean(env.GEMINI_API_KEY?.trim());
  const openaiConfigured = Boolean(env.OPENAI_API_KEY?.trim());

  if ((requested === "gemini" || (!requested && geminiConfigured)) && geminiConfigured) {
    return {
      provider: "gemini",
      configured: true,
      model: env.FROSH_GEMINI_MODEL?.trim() || "gemini-2.5-flash",
      message: "Gemini is connected and can reason, use approved tools, and retain conversation context.",
    };
  }
  if ((requested === "openai" || (!requested && openaiConfigured)) && openaiConfigured) {
    return {
      provider: "openai",
      configured: true,
      model: env.FROSH_MODEL?.trim() || "gpt-6-luna",
      message: "OpenAI is connected and can reason, use approved tools, and retain conversation context.",
    };
  }

  const wanted = requested === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY";
  return {
    provider: "development",
    configured: false,
    message: `No live AI model is configured. Add ${wanted} in the server environment to enable FROSH's real assistant brain.`,
  };
}

export function createProvider(): ProviderClient {
  const status = describeProvider();
  if (status.provider === "gemini") return new GeminiProvider({ model: status.model });
  if (status.provider === "openai") return new OpenAIProvider();
  return new DevelopmentProvider();
}
