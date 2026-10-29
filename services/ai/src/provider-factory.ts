import type { ProviderClient } from "./provider";
import { isStreamingProvider } from "./provider";
import { OpenAIProvider } from "./openai-provider";
import { GeminiProvider } from "./gemini-provider";
import { DevelopmentProvider } from "./mock-provider";
import { ResilientChatProvider } from "./chat-provider";

export type FroshAIProviderName = "gemini" | "openai" | "development";

export type FroshAIProviderStatus = {
  provider: FroshAIProviderName;
  configured: boolean;
  model?: string;
  fallbackProvider?: "gemini" | "openai";
  message: string;
};

type Environment = Record<string, string | undefined>;

function requestedProvider(env: Environment): FroshAIProviderName | undefined {
  const requested = env.FROSH_AI_PROVIDER?.trim().toLowerCase();
  if (!requested) return undefined;
  if (requested === "gemini" || requested === "openai" || requested === "development") return requested;
  return undefined;
}

function requestedFallbackProvider(env: Environment): "gemini" | "openai" | undefined {
  const requested = env.FROSH_AI_FALLBACK_PROVIDER?.trim().toLowerCase();
  return requested === "gemini" || requested === "openai" ? requested : undefined;
}

function isConfigured(name: "gemini" | "openai", env: Environment) {
  return name === "gemini" ? Boolean(env.GEMINI_API_KEY?.trim()) : Boolean(env.OPENAI_API_KEY?.trim());
}

function configuredFallback(primary: FroshAIProviderName, env: Environment) {
  const fallback = requestedFallbackProvider(env);
  return fallback && fallback !== primary && isConfigured(fallback, env) ? fallback : undefined;
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
      fallbackProvider: configuredFallback("gemini", env),
      message: "Gemini is connected and can reason, use approved tools, and retain conversation context.",
    };
  }
  if ((requested === "openai" || (!requested && openaiConfigured)) && openaiConfigured) {
    return {
      provider: "openai",
      configured: true,
      model: env.FROSH_MODEL?.trim() || "gpt-6-luna",
      fallbackProvider: configuredFallback("openai", env),
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

function createConfiguredProvider(name: "gemini" | "openai", model?: string): ProviderClient {
  return name === "gemini" ? new GeminiProvider({ model }) : new OpenAIProvider();
}

export function createProvider(): ProviderClient {
  const status = describeProvider();
  if (status.provider === "gemini") return createConfiguredProvider("gemini", status.model);
  if (status.provider === "openai") return createConfiguredProvider("openai", status.model);
  return new DevelopmentProvider();
}

/**
 * Interactive chat gets a conservative retry/failover layer. Failover is
 * opt-in through FROSH_AI_FALLBACK_PROVIDER so a personal deployment never
 * spends on a second provider unexpectedly. It only retries before any stream
 * event reaches the client; after output/tool work starts, the real error is
 * surfaced instead of replaying a potentially side-effecting request.
 */
export function createChatProvider(): ProviderClient {
  const env = process.env;
  const status = describeProvider(env);
  const primary = createProvider();
  if (!status.configured || !isStreamingProvider(primary)) return primary;

  const fallback = status.fallbackProvider
    ? createConfiguredProvider(status.fallbackProvider)
    : undefined;
  const configuredRetries = Number(env.FROSH_AI_STREAM_RETRIES ?? 1);
  const retries = Number.isFinite(configuredRetries) ? Math.min(2, Math.max(0, Math.floor(configuredRetries))) : 1;
  return new ResilientChatProvider(primary, { fallback, retries });
}
