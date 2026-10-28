import { expect, test } from "bun:test";
import { GeminiProvider } from "../services/ai/src/gemini-provider";
import { buildModelInput } from "../services/ai/src/provider";
import { describeProvider } from "../services/ai/src/provider-factory";

const messages = [{ role: "user" as const, content: "Help me plan a focused study session." }];

test("Gemini provider produces a real model response through the provider boundary", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const provider = new GeminiProvider({
    apiKey: "test-key",
    model: "gemini-test",
    fetcher: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: "Start with a 25-minute focused block." }] } }],
      }), { headers: { "content-type": "application/json" } });
    },
  });

  const result = await provider.generate(buildModelInput(messages));

  expect(result.message).toBe("Start with a 25-minute focused block.");
  expect(result.toolCalls).toEqual([]);
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toContain("models/gemini-test:generateContent");
  expect(requests[0].body.systemInstruction).toBeDefined();
  expect(requests[0].body.tools).toBeDefined();
});

test("Gemini provider returns tool output to the model and never invents a successful tool result", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const replies = [
    { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "does_not_exist", args: { value: "x" } } }] } }] },
    { candidates: [{ content: { role: "model", parts: [{ text: "That tool is unavailable, so I cannot perform that action." }] } }] },
  ];
  const provider = new GeminiProvider({
    apiKey: "test-key",
    fetcher: async (_url, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(replies.shift()), { headers: { "content-type": "application/json" } });
    },
  });

  const result = await provider.generate(buildModelInput(messages));

  expect(result.message).toContain("unavailable");
  expect(result.toolCalls).toHaveLength(1);
  expect(result.toolCalls?.[0]).toMatchObject({ name: "does_not_exist", status: "failed" });
  const contents = requestBodies[1].contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  expect(contents.at(-1)?.role).toBe("function");
  expect(contents.at(-1)?.parts[0].functionResponse).toBeDefined();
});

test("Gemini stores a bounded provider continuation for approval-gated actions and resumes from the approved result", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const replies = [
    { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "desktop_run_command", args: { commandLine: "echo hi" } } }] } }] },
    { candidates: [{ content: { role: "model", parts: [{ text: "The approved command result has been recorded." }] } }] },
  ];
  const provider = new GeminiProvider({
    apiKey: "test-key",
    fetcher: async (_url, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(replies.shift()), { headers: { "content-type": "application/json" } });
    },
  });
  const input = buildModelInput(messages);

  const paused = await provider.generate(input, { runId: "gemini-approval-test" });
  expect(paused.waitingForApproval).toBe(true);
  expect(paused.continuation).toMatchObject({ provider: "gemini", pendingToolName: "desktop_run_command" });
  expect(paused.continuation?.provider).toBe("gemini");
  if (!paused.continuation || paused.continuation.provider !== "gemini") throw new Error("Expected Gemini continuation");

  const resumed = await provider.generate(input, {
    runId: "gemini-approval-test",
    continuation: {
      continuation: paused.continuation,
      toolOutput: { callId: paused.continuation.pendingCallId!, output: JSON.stringify({ exitCode: 0, stdout: "hi" }) },
    },
  });

  expect(resumed.message).toContain("approved command");
  const resumeContents = requestBodies[1].contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  expect(resumeContents.at(-1)?.role).toBe("function");
  expect(resumeContents.at(-1)?.parts[0].functionResponse).toBeDefined();
});

test("Gemini visual analysis sends one explicitly supplied bounded image and no tool declarations", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const provider = new GeminiProvider({
    apiKey: "test-key",
    fetcher: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: "I can see a green notebook on the desk." }] } }],
      }), { headers: { "content-type": "application/json" } });
    },
  });

  const result = await provider.analyzeImage({ data: "aGVsbG8=", mimeType: "image/jpeg", prompt: "What is on the desk?" });

  expect(result.message).toContain("green notebook");
  expect(requests).toHaveLength(1);
  expect(requests[0].tools).toBeUndefined();
  const parts = ((requests[0].contents as Array<{ parts: Array<Record<string, unknown>> }>)[0].parts);
  expect(parts[1].inlineData).toEqual({ mimeType: "image/jpeg", data: "aGVsbG8=" });
});

test("Gemini visual analysis rejects invalid media before it reaches the provider", async () => {
  let called = false;
  const provider = new GeminiProvider({
    apiKey: "test-key",
    fetcher: async () => {
      called = true;
      return new Response("{}", { status: 500 });
    },
  });

  await expect(provider.analyzeImage({ data: "not base64!", mimeType: "image/gif" })).rejects.toThrow("JPEG, PNG, or WebP");
  await expect(provider.analyzeImage({ data: "AAAA=", mimeType: "image/jpeg" })).rejects.toThrow("JPEG, PNG, or WebP");
  expect(called).toBe(false);
});

test("provider status is explicit when no live model is configured and selects the no-cost Gemini route", () => {
  expect(describeProvider({})).toMatchObject({ provider: "development", configured: false });
  expect(describeProvider({ GEMINI_API_KEY: "configured", FROSH_GEMINI_MODEL: "gemini-test" })).toMatchObject({
    provider: "gemini",
    configured: true,
    model: "gemini-test",
  });
  expect(describeProvider({ FROSH_AI_PROVIDER: "gemini" })).toMatchObject({ provider: "development", configured: false });
});
