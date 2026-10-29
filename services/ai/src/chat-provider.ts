import type { FroshStreamEvent, ProviderClient, ProviderGenerateOptions, StreamingProviderClient } from "./provider";
import { FroshProviderAbortError, isStreamingProvider, throwIfProviderAborted } from "./provider";

export type FroshChatProviderOptions = {
  /** Retries are only safe before a provider emitted any event: after a delta
   * or tool event, repeating the prompt could duplicate visible text or work. */
  retries?: number;
  fallback?: ProviderClient;
  retryDelayMs?: number;
};

function errorText(error: unknown) {
  if (error instanceof Error) return `${error.name} ${error.message}`.toLowerCase();
  return String(error).toLowerCase();
}

/** Only retry a clearly transient upstream/provider failure. Refusals,
 * malformed requests, missing credentials, and client cancellation are never
 * retried or failed over. */
export function isRetriableProviderError(error: unknown) {
  if (error instanceof FroshProviderAbortError) return false;
  const text = errorText(error);
  if (/\b(400|401|403|404|422)\b/.test(text)) return false;
  return /\b(408|409|425|429|500|502|503|504)\b/.test(text) ||
    /timeout|timed out|respond in time|network|connection|temporar|unavailable|overloaded|rate limit|fetch failed|stream ended/.test(text);
}

async function delayBeforeRetry(ms: number, signal?: AbortSignal) {
  throwIfProviderAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new FroshProviderAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
  throwIfProviderAborted(signal);
}

/**
 * Chat-specific resilience wrapper. It intentionally delegates non-streaming
 * generation unchanged: providers may have already executed a permissioned
 * tool during a non-streaming turn, so a generic retry would risk repeating a
 * side effect. Stream retries/failover occur only before the first event.
 */
export class ResilientChatProvider implements StreamingProviderClient {
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly candidates: StreamingProviderClient[];

  constructor(primary: StreamingProviderClient, options: FroshChatProviderOptions = {}) {
    this.retries = Math.max(0, Math.min(2, Math.floor(options.retries ?? 1)));
    this.retryDelayMs = Math.max(50, Math.min(2_000, Math.floor(options.retryDelayMs ?? 250)));
    this.candidates = [
      primary,
      ...(options.fallback && isStreamingProvider(options.fallback) ? [options.fallback] : []),
    ];
  }

  generate(input: Parameters<ProviderClient["generate"]>[0], options?: ProviderGenerateOptions) {
    return this.candidates[0].generate(input, options);
  }

  async *stream(
    input: Parameters<StreamingProviderClient["stream"]>[0],
    options: ProviderGenerateOptions = {},
  ): AsyncGenerator<FroshStreamEvent> {
    let lastError: unknown;
    for (let candidateIndex = 0; candidateIndex < this.candidates.length; candidateIndex += 1) {
      const candidate = this.candidates[candidateIndex];
      const attempts = candidateIndex === 0 ? this.retries + 1 : 1;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        throwIfProviderAborted(options.signal);
        let emitted = false;
        let completed = false;
        try {
          for await (const event of candidate.stream(input, options)) {
            throwIfProviderAborted(options.signal);
            emitted = true;
            if (event.type === "done") completed = true;
            yield event;
          }
          if (!completed) throw new Error("Model stream ended without a completed response");
          return;
        } catch (error) {
          if (options.signal?.aborted || error instanceof FroshProviderAbortError) throw error;
          // Once a client has seen output, silently replaying it would be
          // dishonest and might repeat tool work. Surface the actual failure.
          if (emitted || !isRetriableProviderError(error)) throw error;
          lastError = error;
          if (attempt + 1 < attempts) {
            await delayBeforeRetry(this.retryDelayMs * (attempt + 1), options.signal);
          }
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("FROSH could not reach a live AI provider.");
  }
}
