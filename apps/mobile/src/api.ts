import type { FroshDevice, FroshDeviceCredential } from "../../../packages/types/src/device";
import type { FroshAgentRun } from "../../../packages/types/src/agent-run";
import type { FroshApprovalRequest } from "../../../packages/types/src/approval";
import type { FroshToolCall } from "../../../packages/types/src/javis";
import { fetch as expoFetch } from "expo/fetch";
import { sseData, takeSseFrames } from "./sse";
import { clearDeviceCredential, saveDeviceCredential } from "./session";

export const FROSH_API_URL =
  process.env.EXPO_PUBLIC_FROSH_API_URL ?? "http://localhost:3001";

let credential: FroshDeviceCredential | null = null;
let authenticatedUserId: string | null = null;

export function setDeviceCredential(value: FroshDeviceCredential | null) {
  credential = value;
  authenticatedUserId = null;
}

export function hasDeviceCredential() {
  return credential !== null;
}

async function request<T>(path: string, init?: RequestInit, options: { includeCredential?: boolean } = {}): Promise<T> {
  if (credential && Date.parse(credential.expiresAt) <= Date.now()) {
    credential = null;
    authenticatedUserId = null;
    await clearDeviceCredential().catch(() => undefined);
    throw new Error("Device credential has expired. Re-pair this phone.");
  }
  const requestCredential = credential;
  const response = await fetch(`${FROSH_API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(options.includeCredential === false ? {} : requestCredential ? {
        "x-frosh-device-id": requestCredential.deviceId,
        "x-frosh-device-token": requestCredential.token,
      } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401 && requestCredential && credential && credential.deviceId === requestCredential.deviceId && credential.token === requestCredential.token && credential.expiresAt === requestCredential.expiresAt) {
      credential = null;
      authenticatedUserId = null;
      await clearDeviceCredential().catch(() => undefined);
    }
    throw new Error(body?.error ?? `Request failed: ${response.status}`);
  }
  return body as T;
}

export type FroshAssistantStatus = {
  provider: "gemini" | "openai" | "development";
  configured: boolean;
  model?: string;
  message: string;
};

export function getAssistantStatus() {
  return request<{ assistant: FroshAssistantStatus }>("/v1/assistant/status");
}

export function analyzeVision(image: string, mimeType: "image/jpeg" | "image/png" | "image/webp", prompt?: string) {
  return request<{ message: string }>("/v1/vision/analyze", {
    method: "POST",
    body: JSON.stringify({ image, mimeType, ...(prompt?.trim() ? { prompt: prompt.trim() } : {}) }),
  });
}

export type FroshConversationSummary = {
  id: string;
  updatedAt: string;
  preview?: string;
};

export type FroshConversationMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: string;
};

async function currentUserId() {
  if (authenticatedUserId) return authenticatedUserId;
  const session = await request<{ userId: string }>("/v1/session");
  if (!session.userId || session.userId.length > 200 || /[\u0000-\u001f\u007f]/.test(session.userId)) {
    throw new Error("FROSH returned an invalid account session.");
  }
  authenticatedUserId = session.userId;
  return authenticatedUserId;
}

function boundedLimit(value: number, maximum: number, fallback: number) {
  return Number.isFinite(value) ? Math.max(1, Math.min(Math.floor(value), maximum)) : fallback;
}

export async function listConversations(limit = 30) {
  const safeLimit = boundedLimit(limit, 100, 30);
  const userId = await currentUserId();
  return request<{ conversations: FroshConversationSummary[] }>(
    `/v1/conversations/users/${encodeURIComponent(userId)}?limit=${safeLimit}`,
  );
}

export async function getConversation(conversationId: string, limit = 100) {
  const safeLimit = boundedLimit(limit, 200, 100);
  const userId = await currentUserId();
  return request<{ conversation: FroshConversationSummary; messages: FroshConversationMessage[] }>(
    `/v1/conversations/users/${encodeURIComponent(userId)}/${encodeURIComponent(conversationId)}?limit=${safeLimit}`,
  );
}

export type FroshChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; status: "planned" | "completed" | "failed"; toolCallId?: string }
  | { type: "approval"; approvalId?: string }
  | { type: "done"; message: string; toolCalls: FroshToolCall[]; conversationId: string };

const MAX_CHAT_STREAM_BYTES = 2 * 1024 * 1024;

function isStreamEvent(value: unknown): value is FroshChatStreamEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (event.type === "delta") return typeof event.text === "string";
  if (event.type === "tool") return typeof event.name === "string" && (event.status === "planned" || event.status === "completed" || event.status === "failed");
  if (event.type === "approval") return event.approvalId === undefined || typeof event.approvalId === "string";
  return event.type === "done" && typeof event.message === "string" && typeof event.conversationId === "string" && Array.isArray(event.toolCalls);
}

/**
 * Read the API's SSE chat route with Expo's standards-compliant fetch. The
 * request is still authenticated with the short-lived paired-device credential;
 * only text/tool events cross this boundary, never model-provider secrets.
 */
export async function streamMessage(
  message: string,
  conversationId: string | undefined,
  onEvent: (event: FroshChatStreamEvent) => void,
  signal?: AbortSignal,
) {
  const trimmed = message.trim();
  if (!trimmed) throw new Error("message is required");
  if (signal?.aborted) throw new Error("FROSH response was cancelled.");
  if (credential && Date.parse(credential.expiresAt) <= Date.now()) {
    credential = null;
    authenticatedUserId = null;
    await clearDeviceCredential().catch(() => undefined);
    throw new Error("Device credential has expired. Re-pair this phone.");
  }

  const requestCredential = credential;
  const response = await expoFetch(`${FROSH_API_URL}/v1/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(requestCredential ? {
        "x-frosh-device-id": requestCredential.deviceId,
        "x-frosh-device-token": requestCredential.token,
      } : {}),
    },
    body: JSON.stringify({ message: trimmed, conversationId }),
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: unknown };
    if (response.status === 401 && requestCredential && credential?.deviceId === requestCredential.deviceId && credential.token === requestCredential.token) {
      credential = null;
      authenticatedUserId = null;
      await clearDeviceCredential().catch(() => undefined);
    }
    throw new Error(typeof body.error === "string" ? body.error : `Request failed: ${response.status}`);
  }
  if (!response.body) throw new Error("This FROSH app build cannot receive live responses. Update the app and try again.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let receivedBytes = 0;
  let completed = false;
  try {
    while (true) {
      if (signal?.aborted) throw new Error("FROSH response was cancelled.");
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new Error("FROSH response was cancelled.");
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_CHAT_STREAM_BYTES) throw new Error("FROSH response exceeded the safe streaming limit.");
      buffered += decoder.decode(value, { stream: true });
      const extracted = takeSseFrames(buffered);
      buffered = extracted.remainder;
      for (const frame of extracted.frames) {
        const data = sseData(frame);
        if (!data) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(data); } catch { throw new Error("FROSH returned an invalid live response."); }
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as Record<string, unknown>).type === "error") {
          const error = (parsed as Record<string, unknown>).message;
          throw new Error(typeof error === "string" ? error : "FROSH streaming request failed.");
        }
        if (!isStreamEvent(parsed)) throw new Error("FROSH returned an invalid live response.");
        onEvent(parsed);
        if (parsed.type === "done") completed = true;
      }
    }
    buffered += decoder.decode();
    if (buffered.trim()) {
      const data = sseData(buffered);
      if (data) {
        let parsed: unknown;
        try { parsed = JSON.parse(data); } catch { throw new Error("FROSH returned an invalid live response."); }
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as Record<string, unknown>).type === "error") {
          const error = (parsed as Record<string, unknown>).message;
          throw new Error(typeof error === "string" ? error : "FROSH streaming request failed.");
        }
        if (!isStreamEvent(parsed)) throw new Error("FROSH returned an invalid live response.");
        onEvent(parsed);
        if (parsed.type === "done") completed = true;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!completed) throw new Error("FROSH live response ended before completion.");
}

export function startAgentRun(goal: string) {
  return request<FroshAgentRun>("/v1/agent-runs", {
    method: "POST",
    body: JSON.stringify({ goal, background: true }),
  });
}

export async function getAgentRun(id: string) {
  const userId = await currentUserId();
  const response = await request<{ run: FroshAgentRun }>(`/v1/agent-runs/users/${encodeURIComponent(userId)}/${encodeURIComponent(id)}`);
  return response.run;
}

export async function cancelAgentRun(id: string) {
  const userId = await currentUserId();
  const response = await request<{ run: FroshAgentRun }>(
    `/v1/agent-runs/users/${encodeURIComponent(userId)}/${encodeURIComponent(id)}/cancel`,
    { method: "POST" },
  );
  return response.run;
}

export function getApproval(id: string) {
  return request<FroshApprovalRequest>(`/v1/approvals/${id}`);
}

export function resolveApproval(id: string, status: "approved" | "rejected") {
  return request<{ approvalId: string; run: FroshAgentRun }>(`/v1/approvals/${id}`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
}

export function listDevices() {
  return request<{ devices: FroshDevice[] }>("/v1/devices");
}

const MAX_ENROLLMENT_TOKEN_LENGTH = 512;

export async function registerDevice(name: string, capabilities: string[], enrollmentToken: string) {
  const token = enrollmentToken.trim();
  if (!token || token.length > MAX_ENROLLMENT_TOKEN_LENGTH || /[\u0000-\u001f\u007f]/.test(token)) {
    throw new Error("Enrollment token is invalid.");
  }
  const result = await request<{ device: FroshDevice; credential: FroshDeviceCredential }>("/v1/devices", {
    method: "POST",
    headers: { "x-frosh-device-enrollment-token": token },
    body: JSON.stringify({ name, platform: "android", capabilities }),
  }, { includeCredential: false });
  await saveDeviceCredential(result.credential);
  setDeviceCredential(result.credential);
  return result.device;
}
