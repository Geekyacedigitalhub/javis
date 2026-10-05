import type { FroshDevice } from "../../../packages/types/src/device";
import type { FroshAgentRun } from "../../../packages/types/src/agent-run";
import type { FroshApprovalRequest } from "../../../packages/types/src/approval";
import type { FroshResponse } from "../../../packages/types/src/javis";

export const FROSH_API_URL =
  process.env.EXPO_PUBLIC_FROSH_API_URL ?? "http://localhost:3001";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${FROSH_API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error ?? `Request failed: ${response.status}`);
  return body as T;
}

export function sendMessage(message: string, conversationId?: string) {
  return request<FroshResponse>("/v1/chat", {
    method: "POST",
    body: JSON.stringify({ message, conversationId }),
  });
}

export function startAgentRun(goal: string) {
  return request<FroshAgentRun>("/v1/agent-runs", {
    method: "POST",
    body: JSON.stringify({ goal }),
  });
}

export function getAgentRun(id: string) {
  return request<FroshAgentRun>(`/v1/agent-runs/${id}`);
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

export function registerDevice(name: string, capabilities: string[]) {
  return request<FroshDevice>("/v1/devices", {
    method: "POST",
    body: JSON.stringify({ name, platform: "android", capabilities }),
  });
}
