import type { FroshToolCall } from "../../../packages/types/src/javis";
import type { FroshProviderContinuation } from "../../../packages/types/src/agent-run";
import { executeToolCall } from "../../tools/src";
import {
  buildModelInput,
  FroshProviderAbortError,
  throwIfProviderAborted,
  type FroshStreamEvent,
  type MissionEvaluation,
  type ProviderGenerateOptions,
  type ProviderResponse,
} from "./provider";

const GEMINI_API_ORIGIN = "https://generativelanguage.googleapis.com/v1beta/models/";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const MAX_TOOL_ROUNDS = 8;
const MAX_CONTINUATION_BYTES = 120_000;
const MAX_STREAM_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_VISION_IMAGE_BYTES = 3 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type GeminiPart = Record<string, unknown>;
type GeminiContent = { role: "user" | "model" | "function"; parts: GeminiPart[] };

type GeminiProviderOptions = {
  apiKey?: string;
  model?: string;
  fetcher?: FetchLike;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeText(value: unknown, max = 1_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

function imageByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor(base64.length * 3 / 4) - padding;
}

function validBase64Shape(value: string): boolean {
  // Accept ordinary unpadded Base64 too, but reject impossible 1-character
  // tails and padded values that cannot occupy a complete Base64 quartet.
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) &&
    value.length % 4 !== 1 &&
    (!value.includes("=") || value.length % 4 === 0);
}

function validImage(input: { data: string; mimeType: string }): boolean {
  return ALLOWED_IMAGE_TYPES.has(input.mimeType) &&
    validBase64Shape(input.data) &&
    imageByteLength(input.data) > 0 &&
    imageByteLength(input.data) <= MAX_VISION_IMAGE_BYTES;
}

function validModel(value: string | undefined): string {
  const model = value?.trim() || DEFAULT_GEMINI_MODEL;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(model)) {
    throw new Error("FROSH_GEMINI_MODEL contains invalid characters.");
  }
  return model;
}

function normalizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSchema);
  const record = asRecord(value);
  if (!record) return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    // Gemini's function schema accepts a useful JSON Schema subset. This
    // keyword is neither useful to the model nor accepted by every API version.
    if (key === "additionalProperties" || key === "$schema") continue;
    if (key === "type" && typeof item === "string") {
      normalized.type = item.toUpperCase();
    } else {
      normalized[key] = normalizeSchema(item);
    }
  }
  return normalized;
}

function contentFromMessages(messages: ReturnType<typeof buildModelInput>["messages"]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const text = message.content.trim();
    if (!text) continue;
    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.role === "tool" ? `Tool result:\n${text}` : text }],
    });
  }
  return contents;
}

function systemInstruction(input: ReturnType<typeof buildModelInput>) {
  const additional = input.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean);
  return {
    parts: [{ text: [input.system, ...additional].join("\n\n") }],
  };
}

function responseMessage(payload: unknown): string {
  const root = asRecord(payload);
  const error = asRecord(root?.error);
  return safeText(error?.message, 300) ?? "Gemini did not return a usable response.";
}

function ssePayload(frame: string): unknown | null {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw new Error("Gemini returned an invalid streaming response.");
  }
}

function candidateContent(payload: unknown): GeminiContent | null {
  const root = asRecord(payload);
  const candidates = Array.isArray(root?.candidates) ? root.candidates : [];
  const first = asRecord(candidates[0]);
  const content = asRecord(first?.content);
  const role = content?.role;
  const parts = content?.parts;
  if ((role !== "model" && role !== "user" && role !== "function") || !Array.isArray(parts)) return null;
  const safeParts = parts.map(asRecord).filter((part): part is Record<string, unknown> => Boolean(part));
  return safeParts.length ? { role, parts: safeParts } : null;
}

function textFromContent(content: GeminiContent): string {
  return content.parts
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();
}

function functionCalls(content: GeminiContent): Array<{ name: string; arguments: Record<string, unknown> }> {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  for (const part of content.parts) {
    const raw = asRecord(part.functionCall);
    const name = safeText(raw?.name, 120);
    const args = asRecord(raw?.args) ?? {};
    if (name) calls.push({ name, arguments: args });
  }
  return calls;
}

function functionResponse(name: string, result: unknown): GeminiContent {
  return {
    role: "function",
    parts: [{
      functionResponse: {
        name,
        // Gemini requires an object here. Keep the actual tool output nested so
        // a string/array/null result remains representable without coercion.
        response: { result },
      },
    }],
  };
}

function cloneContents(value: Array<Record<string, unknown>>): GeminiContent[] {
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > MAX_CONTINUATION_BYTES) {
    throw new Error("The paused AI task is too large to resume safely. Start a new task with a narrower goal.");
  }
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("The saved Gemini task state is invalid.");
  const contents: GeminiContent[] = [];
  for (const item of parsed) {
    const record = asRecord(item);
    const role = record?.role;
    const parts = record?.parts;
    if ((role !== "user" && role !== "model" && role !== "function") || !Array.isArray(parts)) {
      throw new Error("The saved Gemini task state is invalid.");
    }
    const safeParts = parts.map(asRecord).filter((part): part is GeminiPart => Boolean(part));
    if (!safeParts.length) throw new Error("The saved Gemini task state is invalid.");
    contents.push({ role, parts: safeParts });
  }
  return contents;
}

function ensureContinuationSize(contents: GeminiContent[]): Array<Record<string, unknown>> {
  const persisted = contents.map((content) => ({ role: content.role, parts: content.parts }));
  if (new TextEncoder().encode(JSON.stringify(persisted)).byteLength > MAX_CONTINUATION_BYTES) {
    throw new Error("The AI task became too large to pause safely. Start a new task with a narrower goal.");
  }
  return persisted;
}

async function executeTimedToolCall(call: FroshToolCall, runId?: string) {
  const startedAt = Date.now();
  const result = await executeToolCall(call, { runId });
  return { ...result, durationMs: Math.max(0, Date.now() - startedAt) };
}

function throwIfAborted(signal?: AbortSignal) {
  throwIfProviderAborted(signal);
}

/** Keep FROSH's provider timeout independent of the client cancellation
 * signal, while still cancelling the actual network request in either case. */
function abortableRequest(signal?: AbortSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 30_000);
  return {
    signal: controller.signal,
    wasTimedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

function providerAbortError(error: unknown, callerSignal: AbortSignal | undefined, timedOut: boolean): never {
  if (callerSignal?.aborted || error instanceof FroshProviderAbortError) throw new FroshProviderAbortError();
  if (timedOut || (error instanceof Error && error.name === "AbortError")) {
    throw new Error("Gemini did not respond in time. Please retry shortly.");
  }
  throw error;
}

/**
 * A first-class Gemini adapter. It uses Gemini's REST API directly so FROSH
 * does not add another heavyweight SDK, and it preserves the same permissioned
 * tool protocol as the OpenAI adapter.
 */
export class GeminiProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetcher: FetchLike;

  constructor(options: GeminiProviderOptions = {}) {
    this.apiKey = options.apiKey?.trim() || process.env.GEMINI_API_KEY?.trim() || "";
    if (!this.apiKey) throw new Error("GEMINI_API_KEY is not configured");
    this.model = validModel(options.model ?? process.env.FROSH_GEMINI_MODEL);
    this.fetcher = options.fetcher ?? fetch;
  }

  private async generateContent(body: Record<string, unknown>, callerSignal?: AbortSignal): Promise<GeminiContent> {
    throwIfAborted(callerSignal);
    const endpoint = `${GEMINI_API_ORIGIN}${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const request = abortableRequest(callerSignal);
    try {
      const response = await this.fetcher(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: request.signal,
      });
      throwIfAborted(callerSignal);
      const text = await response.text();
      let payload: unknown;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        throw new Error("Gemini returned an invalid response.");
      }
      if (!response.ok) {
        throw new Error(`Gemini request failed (${response.status}): ${responseMessage(payload)}`);
      }
      const content = candidateContent(payload);
      if (!content) throw new Error("Gemini returned no usable candidate.");
      return content;
    } catch (error) {
      providerAbortError(error, callerSignal, request.wasTimedOut());
    } finally {
      request.dispose();
    }
  }

  private async *streamContent(body: Record<string, unknown>, callerSignal?: AbortSignal): AsyncGenerator<unknown> {
    throwIfAborted(callerSignal);
    const endpoint = `${GEMINI_API_ORIGIN}${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`;
    const request = abortableRequest(callerSignal);
    try {
      const response = await this.fetcher(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal: request.signal,
      });
      throwIfAborted(callerSignal);
      if (!response.ok) {
        const text = await response.text();
        let payload: unknown = {};
        try { payload = text ? JSON.parse(text) : {}; } catch { /* fall through to a safe error */ }
        throw new Error(`Gemini request failed (${response.status}): ${responseMessage(payload)}`);
      }
      if (!response.body) throw new Error("Gemini returned an empty streaming response.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      let receivedBytes = 0;
      const consume = function* (final = false): Generator<unknown> {
        let boundary = buffered.search(/\r?\n\r?\n/);
        while (boundary >= 0) {
          const frame = buffered.slice(0, boundary);
          const separatorLength = buffered.startsWith("\r\n", boundary) ? 4 : 2;
          buffered = buffered.slice(boundary + separatorLength);
          const payload = ssePayload(frame);
          if (payload !== null) yield payload;
          boundary = buffered.search(/\r?\n\r?\n/);
        }
        if (final && buffered.trim()) {
          const payload = ssePayload(buffered);
          buffered = "";
          if (payload !== null) yield payload;
        }
      };

      try {
        while (true) {
          throwIfAborted(callerSignal);
          const { done, value } = await reader.read();
          throwIfAborted(callerSignal);
          if (done) break;
          receivedBytes += value.byteLength;
          if (receivedBytes > MAX_STREAM_RESPONSE_BYTES) {
            throw new Error("Gemini stream exceeded FROSH's safe response limit.");
          }
          buffered += decoder.decode(value, { stream: true });
          yield* consume();
        }
        buffered += decoder.decode();
        yield* consume(true);
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      providerAbortError(error, callerSignal, request.wasTimedOut());
    } finally {
      request.dispose();
    }
  }

  private modelRequest(input: ReturnType<typeof buildModelInput>, contents: GeminiContent[]): Record<string, unknown> {
    const request: Record<string, unknown> = {
      systemInstruction: systemInstruction(input),
      contents,
      generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
    };
    // An empty functionDeclarations list is rejected by some Gemini API
    // versions, and a plain-text task should not expose tools unnecessarily.
    if (input.tools.length) {
      request.tools = [{
        functionDeclarations: input.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: normalizeSchema(tool.parameters ?? { type: "object", properties: {} }),
        })),
      }];
    }
    return request;
  }

  async *stream(
    input: ReturnType<typeof buildModelInput>,
    options: ProviderGenerateOptions = {},
  ): AsyncGenerator<FroshStreamEvent> {
    if (options.continuation && options.continuation.continuation.provider !== "gemini") {
      throw new Error("This run was started with a different AI provider and cannot be resumed here.");
    }

    const rawContinuation = options.continuation?.continuation;
    const priorContinuation = rawContinuation?.provider === "gemini" ? rawContinuation : undefined;
    let contents: GeminiContent[];
    if (priorContinuation) {
      contents = cloneContents(priorContinuation.contents);
      if (!options.continuation?.toolOutput || !priorContinuation.pendingToolName) {
        throw new Error("The paused Gemini task has no pending tool result to resume.");
      }
      let output: unknown = options.continuation.toolOutput.output;
      try { output = JSON.parse(options.continuation.toolOutput.output); } catch { /* Non-JSON tool output is valid. */ }
      contents.push(functionResponse(priorContinuation.pendingToolName, output));
    } else {
      contents = contentFromMessages(input.messages);
    }
    if (!contents.length) throw new Error("A Gemini request needs at least one message.");

    const executedCalls: FroshToolCall[] = [];
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const answer: GeminiContent = { role: "model", parts: [] };
      throwIfAborted(options.signal);
      for await (const payload of this.streamContent(this.modelRequest(input, contents), options.signal)) {
        throwIfAborted(options.signal);
        const content = candidateContent(payload);
        if (!content) continue;
        for (const part of content.parts) {
          answer.parts.push(part);
          if (typeof part.text === "string" && part.text) {
            yield { type: "delta", text: part.text };
          }
        }
      }
      if (!answer.parts.length) throw new Error("Gemini stream ended without a usable candidate.");
      contents.push(answer);

      const calls = functionCalls(answer);
      if (!calls.length) {
        yield { type: "done", message: textFromContent(answer), toolCalls: executedCalls };
        return;
      }

      for (const call of calls) {
        const planned: FroshToolCall = {
          id: `gemini-${round}-${crypto.randomUUID()}`,
          name: call.name,
          arguments: call.arguments,
          status: "planned",
        };
        throwIfAborted(options.signal);
        yield { type: "tool", name: planned.name, status: "planned", toolCallId: planned.id };
        const result = await executeTimedToolCall(planned, options.runId);
        throwIfAborted(options.signal);
        executedCalls.push(result);
        yield {
          type: "tool",
          name: planned.name,
          status: result.status === "completed" ? "completed" : "failed",
          toolCallId: planned.id,
        };

        const approvalId = asRecord(result.result)?.approvalId;
        if (typeof approvalId === "string") {
          yield { type: "approval", approvalId };
          yield {
            type: "done",
            message: "FROSH is waiting for your approval before continuing.",
            toolCalls: executedCalls,
          };
          return;
        }
        contents.push(functionResponse(call.name, result));
      }
    }

    throwIfAborted(options.signal);
    yield {
      type: "done",
      message: "FROSH reached the maximum tool-execution rounds for this request.",
      toolCalls: executedCalls,
    };
  }

  async generate(
    input: ReturnType<typeof buildModelInput>,
    options: ProviderGenerateOptions = {},
  ): Promise<ProviderResponse> {
    if (options.continuation && options.continuation.continuation.provider !== "gemini") {
      throw new Error("This run was started with a different AI provider and cannot be resumed here.");
    }

    const rawContinuation = options.continuation?.continuation;
    const priorContinuation = rawContinuation?.provider === "gemini" ? rawContinuation : undefined;
    let contents: GeminiContent[];
    if (priorContinuation) {
      const continuation = priorContinuation;
      contents = cloneContents(continuation.contents);
      if (!options.continuation?.toolOutput || !continuation.pendingToolName) {
        throw new Error("The paused Gemini task has no pending tool result to resume.");
      }
      const resumedOutput = options.continuation!.toolOutput!;
      let output: unknown = resumedOutput.output;
      try {
        output = JSON.parse(resumedOutput.output);
      } catch {
        // A non-JSON result is still a valid tool result and is wrapped below.
      }
      contents.push(functionResponse(continuation.pendingToolName, output));
    } else {
      contents = contentFromMessages(input.messages);
    }

    if (!contents.length) throw new Error("A Gemini request needs at least one message.");
    const executedCalls: FroshToolCall[] = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      throwIfAborted(options.signal);
      const answer = await this.generateContent(this.modelRequest(input, contents), options.signal);
      throwIfAborted(options.signal);
      contents.push(answer);
      const calls = functionCalls(answer);
      if (!calls.length) {
        return { message: textFromContent(answer), toolCalls: executedCalls };
      }

      for (const call of calls) {
        const planned: FroshToolCall = {
          id: `gemini-${round}-${crypto.randomUUID()}`,
          name: call.name,
          arguments: call.arguments,
          status: "planned",
        };
        throwIfAborted(options.signal);
        const result = await executeTimedToolCall(planned, options.runId);
        throwIfAborted(options.signal);
        executedCalls.push(result);

        const resultRecord = asRecord(result.result);
        const approvalId = resultRecord?.approvalId;
        if (typeof approvalId === "string") {
          const continuation: FroshProviderContinuation = {
            provider: "gemini",
            contents: ensureContinuationSize(contents),
            pendingCallId: planned.id,
            pendingToolName: call.name,
          };
          return {
            message: "FROSH is waiting for your approval before continuing.",
            toolCalls: executedCalls,
            waitingForApproval: true,
            continuation,
          };
        }
        contents.push(functionResponse(call.name, result));
      }
    }

    throwIfAborted(options.signal);
    return {
      message: "FROSH reached the maximum tool-execution rounds for this request.",
      toolCalls: executedCalls,
    };
  }

  /** Analyze an image only when the client explicitly uploads one. The API does
   * not retain the base64 payload, and this method never enables device or
   * external-action tools for visual analysis. */
  async analyzeImage(input: { data: string; mimeType: string; prompt?: string }): Promise<{ message: string }> {
    const mimeType = input.mimeType.trim().toLowerCase();
    const data = input.data.trim();
    if (!validImage({ data, mimeType })) {
      throw new Error("The image must be a JPEG, PNG, or WebP file under 3 MB.");
    }
    const prompt = safeText(input.prompt, 2_000) ?? "Describe what is visible, identify useful details, and say clearly when something is uncertain.";
    const content = await this.generateContent({
      systemInstruction: {
        parts: [{ text: [
          "You are FROSH's visual assistant.",
          "Analyze only the image the user explicitly provided.",
          "Be helpful, concise, and honest about uncertainty.",
          "Do not identify people, infer sensitive traits, or claim to have taken an external action.",
        ].join(" ") }],
      },
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { mimeType, data } },
        ],
      }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
    });
    const message = textFromContent(content);
    if (!message) throw new Error("Gemini returned no usable visual analysis.");
    return { message };
  }

  async evaluateMission(input: { goal: string; step: string; result: string }): Promise<MissionEvaluation> {
    const content = await this.generateContent({
      systemInstruction: {
        parts: [{ text: [
          "You are FROSH's mission evaluator.",
          "Evaluate only the supplied mission goal, step, and result.",
          "Do not execute tools or claim actions outside the supplied result.",
          "Return JSON with complete, nextAction, reason, and optional nextStep.",
          "nextAction must be continue, recover, or finish.",
          "Use finish only when the supplied result demonstrates the overall goal is achieved.",
        ].join(" ") }],
      },
      contents: [{ role: "user", parts: [{ text: JSON.stringify(input) }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 512 },
    });
    try {
      const parsed = JSON.parse(textFromContent(content)) as Record<string, unknown>;
      const nextAction = parsed.nextAction === "recover" || parsed.nextAction === "finish"
        ? parsed.nextAction
        : "continue";
      return {
        complete: nextAction === "finish" || parsed.complete === true,
        nextAction,
        reason: safeText(parsed.reason, 600) ?? "Mission evaluation completed.",
        nextStep: safeText(parsed.nextStep, 600),
      };
    } catch {
      return { complete: false, nextAction: "continue", reason: "Gemini returned an unreadable mission evaluation; continuing conservatively." };
    }
  }
}
