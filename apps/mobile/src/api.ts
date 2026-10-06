import type { FroshDevice, FroshDeviceCredential } from "../../../packages/types/src/device";
import type { FroshAgentRun } from "../../../packages/types/src/agent-run";
import type { FroshApprovalRequest } from "../../../packages/types/src/approval";
import type { FroshResponse } from "../../../packages/types/src/javis";
import { clearDeviceCredential, saveDeviceCredential } from "./session";

export const FROSH_API_URL =
  process.env.EXPO_PUBLIC_FROSH_API_URL ?? "http://localhost:3001";

let credential: FroshDeviceCredential | null = null;

export function setDeviceCredential(value: FroshDeviceCredential | null) {
  credential = value;
}

export function hasDeviceCredential() {
  return credential !== null;
}

async function request<T>(path: string, init?: RequestInit, options: { includeCredential?: boolean } = {}): Promise<T> {
  if (credential && Date.parse(credential.expiresAt) <= Date.now()) {
    credential = null;
    await clearDeviceCredential().catch(() => undefined);
    throw new Error("Device credential has expired. Re-pair this phone.");
  }
  const response = await fetch(`${FROSH_API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(options.includeCredential === false ? {} : credential ? {
        "x-frosh-device-id": credential.deviceId,
        "x-frosh-device-token": credential.token,
      } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401 && credential) {
      credential = null;
      await clearDeviceCredential().catch(() => undefined);
    }
    throw new Error(body?.error ?? `Request failed: ${response.status}`);
  }
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

const MAX_ENROLLMENT_TOKEN_LENGTH = 512;

export async function registerDevice(name: string, capabilities: string[], enrollmentToken: string) {
  const token = enrollmentToken.trim();
  if (!token || token.length > MAX_ENROLLMENT_TOKEN_LENGTH || /[\\u0000-\\u001f\\u007f]/.test(token)) {
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
