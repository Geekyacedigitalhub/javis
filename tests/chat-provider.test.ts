import { expect, test } from "bun:test";
import { ResilientChatProvider } from "../services/ai/src/chat-provider";
import { buildModelInput, type FroshStreamEvent, type StreamingProviderClient } from "../services/ai/src/provider";

const input = buildModelInput([{ role: "user", content: "Give me a concise status update." }]);

function streamingProvider(events: FroshStreamEvent[] | Error, calls: { value: number }): StreamingProviderClient {
  return {
    async generate() {
      return { message: "unused", toolCalls: [] };
    },
    async *stream() {
      calls.value += 1;
      if (events instanceof Error) throw events;
      yield* events;
    },
  };
}

test("chat resilience retries a transient failure before any visible event", async () => {
  const primaryCalls = { value: 0 };
  const fallbackCalls = { value: 0 };
  const primary = streamingProvider(new Error("Gemini request failed (503): unavailable"), primaryCalls);
  const fallback = streamingProvider([
    { type: "delta", text: "Recovered response." },
    { type: "done", message: "Recovered response.", toolCalls: [] },
  ], fallbackCalls);
  const provider = new ResilientChatProvider(primary, { fallback, retries: 1, retryDelayMs: 1 });

  const events: FroshStreamEvent[] = [];
  for await (const event of provider.stream(input)) events.push(event);

  expect(primaryCalls.value).toBe(2);
  expect(fallbackCalls.value).toBe(1);
  expect(events).toEqual([
    { type: "delta", text: "Recovered response." },
    { type: "done", message: "Recovered response.", toolCalls: [] },
  ]);
});

test("chat resilience never retries after a delta has reached the user", async () => {
  const primaryCalls = { value: 0 };
  const fallbackCalls = { value: 0 };
  const primary: StreamingProviderClient = {
    async generate() { return { message: "unused", toolCalls: [] }; },
    async *stream() {
      primaryCalls.value += 1;
      yield { type: "delta", text: "Partial" };
      throw new Error("Gemini request failed (503): unavailable");
    },
  };
  const fallback = streamingProvider([
    { type: "done", message: "Should not run", toolCalls: [] },
  ], fallbackCalls);
  const provider = new ResilientChatProvider(primary, { fallback, retries: 2, retryDelayMs: 1 });
  const iterator = provider.stream(input);

  await expect(iterator.next()).resolves.toEqual({ value: { type: "delta", text: "Partial" }, done: false });
  await expect(iterator.next()).rejects.toThrow("503");
  expect(primaryCalls.value).toBe(1);
  expect(fallbackCalls.value).toBe(0);
});

test("chat resilience does not retry caller cancellation", async () => {
  const calls = { value: 0 };
  const controller = new AbortController();
  controller.abort();
  const provider = new ResilientChatProvider(
    streamingProvider(new Error("Gemini request failed (503): unavailable"), calls),
    { retries: 2, retryDelayMs: 1 },
  );

  await expect(provider.stream(input, { signal: controller.signal }).next()).rejects.toThrow("response was cancelled");
  expect(calls.value).toBe(0);
});
