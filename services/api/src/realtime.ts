import type { FroshEvent } from "../../../packages/types/src/events";
import type { FroshDeviceCommand } from "../../../packages/types/src/events";
import {
  authenticateDevice,
  completeDeviceCommandLedger,
  createDeviceCommandLedger,
  getDeviceCommandLedger,
  getDeviceCommandLedgerByIdempotency,
  markDeviceCommandUnknown,
  markDeviceCommandDispatched,
  markDeviceOffline,
} from "./devices";

type Client = {
  id: string;
  socket: WebSocket;
  deviceId?: string;
  deviceToken?: string;
  authCheck?: ReturnType<typeof setInterval>;
};

const clients = new Map<string, Client>();
const latestClientByDevice = new Map<string, string>();

function resolvePendingCommandsForClient(clientId: string) {
  for (const [requestId, pending] of pendingCommands) {
    if (pending.clientId !== clientId) continue;
    pendingCommands.delete(requestId);
    clearTimeout(pending.timeout);
    void markCommandUnknown(requestId, "The Android device connection was removed before acknowledging the command. The outcome is unknown.");
    pending.resolve({
      accepted: false,
      message: "The Android device connection was removed before acknowledging the command. The outcome is unknown; do not automatically retry a side-effecting action.",
      data: { outcome: "unknown", retryable: false, reason: "device_connection_removed" },
    });
  }
}

export function addRealtimeClient(socket: WebSocket, deviceId?: string, deviceToken?: string) {
  const id = crypto.randomUUID();
  const configuredInterval = Number(process.env.FROSH_DEVICE_AUTH_CHECK_INTERVAL_MS ?? 5000);
  const authCheckInterval = Number.isFinite(configuredInterval)
    ? Math.min(60000, Math.max(1000, Math.floor(configuredInterval)))
    : 5000;
  const authCheck = deviceId && deviceToken
    ? setInterval(() => {
        void authenticateDevice(deviceId, deviceToken)
          .then((authenticated) => { if (!authenticated) socket.close(); })
          .catch(() => socket.close());
      }, authCheckInterval)
    : undefined;
  clients.set(id, { id, socket, deviceId, deviceToken, authCheck });
  if (deviceId) {
    const previousClientId = latestClientByDevice.get(deviceId);
    // Make the new socket authoritative before retiring the old one. Otherwise
    // removing the old socket can briefly mark the device offline while the new
    // socket is already connected, and its async offline write can race the new
    // connection's online state.
    latestClientByDevice.set(deviceId, id);
    if (previousClientId && previousClientId !== id) {
      removeRealtimeClient(previousClientId);
    }
  }

  socket.addEventListener("close", () => {
    if (authCheck) clearInterval(authCheck);
    clients.delete(id);
    if (deviceId && latestClientByDevice.get(deviceId) === id) {
      latestClientByDevice.delete(deviceId);
      void markDeviceOffline(deviceId).catch(() => undefined);
    }
    resolvePendingCommandsForClient(id);
  });
  return id;
}

export function removeRealtimeClient(id: string) {
  const client = clients.get(id);
  if (!client) return;
  if (client.authCheck) clearInterval(client.authCheck);
  resolvePendingCommandsForClient(id);
  clients.delete(id);
  if (client.deviceId && latestClientByDevice.get(client.deviceId) === id) {
    latestClientByDevice.delete(client.deviceId);
    void markDeviceOffline(client.deviceId).catch(() => undefined);
  }
  if (client.socket.readyState === WebSocket.OPEN || client.socket.readyState === WebSocket.CONNECTING) {
    try { client.socket.close(); } catch { /* already closed */ }
  }
}

export function broadcast(event: FroshEvent) {
  // Device-authenticated realtime sockets must never receive global control-center events.
  // Only device-scoped events are eligible for delivery, and they are routed to the
  // authenticated socket for that exact device.
  if (event.type !== "device.updated") return;
  sendToDevice(event.device.id, event);
}

export async function getAuthenticatedCommandClient(deviceId: string) {
  const clientId = latestClientByDevice.get(deviceId);
  const client = clientId ? clients.get(clientId) : undefined;
  if (!client || client.deviceId !== deviceId || !client.deviceToken || client.socket.readyState !== WebSocket.OPEN) {
    return null;
  }
  const authenticated = await authenticateDevice(deviceId, client.deviceToken).catch(() => false);
  if (!authenticated) {
    removeRealtimeClient(client.id);
    return null;
  }
  const current = clients.get(client.id);
  if (!current || current.deviceId !== deviceId || current.deviceToken !== client.deviceToken || current.socket.readyState !== WebSocket.OPEN) {
    return null;
  }
  return current;
}

export function sendToDevice(deviceId: string, event: FroshEvent) {
  const clientId = latestClientByDevice.get(deviceId);
  if (!clientId) return false;
  const client = clients.get(clientId);
  if (!client || client.deviceId !== deviceId || client.socket.readyState !== WebSocket.OPEN) return false;
  client.socket.send(JSON.stringify(event));
  return true;
}

export function disconnectDeviceClients(deviceId: string) {
  const matching = [...clients.values()].filter(client => client.deviceId === deviceId);
  for (const client of matching) {
    removeRealtimeClient(client.id);
  }
  return matching.length;
}

export function realtimeClientCount() {
  return clients.size;
}

export function shutdownRealtime() {
  const clientIds = [...clients.keys()];
  for (const clientId of clientIds) {
    removeRealtimeClient(clientId);
  }
  // Any pending command not tied to a currently tracked client is also terminal
  // on process shutdown: never leave a caller waiting for a result that cannot arrive.
  for (const [requestId, pending] of pendingCommands) {
    pendingCommands.delete(requestId);
    clearTimeout(pending.timeout);
    void markCommandUnknown(requestId, "The realtime service shut down before the command was acknowledged. The outcome is unknown.");
    pending.resolve({
      accepted: false,
      message: "The realtime service is shutting down before the command was acknowledged. The outcome is unknown; do not automatically retry a side-effecting action.",
      data: { outcome: "unknown", retryable: false, reason: "realtime_shutdown" },
    });
  }
}

type DeviceCommandResult = { accepted: boolean; message: string; data?: unknown };

type PendingCommand = {
  clientId: string;
  deviceId: string;
  resolve: (value: DeviceCommandResult) => void;
  reject: (error: Error) => void;
  command: FroshDeviceCommand["command"];
  timeout: ReturnType<typeof setTimeout>;
};


function stableCommandPayload(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableCommandPayload).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableCommandPayload(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function hashCommandPayload(payload: unknown) {
  const bytes = new TextEncoder().encode(stableCommandPayload(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

const MAX_COMMAND_VALUE_LENGTH = 512;
const MAX_MESSAGE_RECIPIENT_LENGTH = 320;
const MAX_MESSAGE_BODY_LENGTH = 8000;
const MAX_NOTIFICATION_ID_LENGTH = 200;
const MAX_PROVIDER_LENGTH = 40;
const MAX_COMMAND_PAYLOAD_BYTES = 32 * 1024;

function validCommandText(value: string | undefined, maxLength: number) {
  return value === undefined || value.length <= maxLength;
}

async function prepareCommandLedger(input: {
  requestId: string;
  deviceId: string;
  command: string;
  payload: unknown;
  idempotencyKey?: string;
}) {
  const serializedPayload = stableCommandPayload(input.payload);
  if (serializedPayload.length > MAX_COMMAND_PAYLOAD_BYTES) {
    return { kind: "error" as const, reason: "command_payload_too_large" };
  }
  const payloadHash = await hashCommandPayload(input.payload);
  const idempotencyKey = input.idempotencyKey?.trim() || input.requestId;
  if (idempotencyKey.length > 200) return { kind: "error" as const, reason: "idempotency_key_too_long" };
  try {
    const created = await createDeviceCommandLedger({
      requestId: input.requestId,
      deviceId: input.deviceId,
      command: input.command,
      payloadHash,
      idempotencyKey,
    });
    if (created) return { kind: "new" as const, payloadHash, idempotencyKey };
    const existing = await getDeviceCommandLedgerByIdempotency(input.deviceId, idempotencyKey);
    if (!existing || existing.command !== input.command || existing.payloadHash !== payloadHash) {
      return { kind: "conflict" as const, reason: "idempotency_key_reused_with_different_command" };
    }
    if (existing.state === "completed") {
      return { kind: "completed" as const, payloadHash, idempotencyKey, result: {
        accepted: existing.accepted === true,
        message: existing.message ?? "The command result was recovered from durable storage.",
        data: existing.data,
      }};
    }
    return { kind: "unknown" as const, payloadHash, idempotencyKey, reason: existing.state === "unknown"
      ? "idempotency_key_already_has_unknown_outcome"
      : "idempotency_key_already_in_progress" };
  } catch {
    return { kind: "error" as const, reason: "ledger_write_failed" };
  }
}

async function markCommandUnknown(requestId: string, reason: string) {
  await markDeviceCommandUnknown(requestId, reason).catch(() => undefined);
}

const pendingCommands = new Map<string, PendingCommand>();

const commandTimeoutResult = {
  accepted: false,
  message: "The Android device did not acknowledge the command. The outcome is unknown; do not automatically retry a side-effecting action.",
  data: { outcome: "unknown", retryable: false },
};

export async function sendDeviceCommand(deviceId: string, command: Extract<FroshDeviceCommand, { type: "device.command" }>["command"], value?: string, idempotencyKey?: string) {
  const client = await getAuthenticatedCommandClient(deviceId);
  if (!client) return { accepted: false, message: "The Android device is not connected or its credential is no longer valid." };
  const latestId = client.id;
  if (!validCommandText(value, MAX_COMMAND_VALUE_LENGTH)) {
    return { accepted: false, message: "Command value is too large." };
  }
  const requestId = crypto.randomUUID();
  const payload = {
    type: "device.command",
    deviceId,
    command,
    ...(command === "open_app" ? { appName: value } : command === "media_control" ? { action: value } : command === "contacts_search" ? { query: value } : command === "call_number" ? { phoneNumber: value } : {}),
  };
  const ledger = await prepareCommandLedger({ requestId, deviceId, command, payload, idempotencyKey });
  if (ledger.kind === "completed") return ledger.result;
  if (ledger.kind !== "new") {
    return { accepted: false, message: ledger.kind === "unknown" ? "This idempotency key already has an unresolved command outcome. Do not automatically retry it." : "The command could not be safely recorded or the idempotency key conflicts with another command.", data: { outcome: "unknown", retryable: false, reason: ledger.reason } };
  }
  return new Promise<DeviceCommandResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const pending = pendingCommands.get(requestId);
      if (!pending) return;
      pendingCommands.delete(requestId);
      void markCommandUnknown(requestId, "The Android device did not acknowledge the command before the server timeout. The outcome is unknown.");
      pending.resolve(commandTimeoutResult);
    }, 15000);
    pendingCommands.set(requestId, { clientId: latestId, deviceId, command, resolve, reject, timeout });
    try {
      client.socket.send(JSON.stringify({ ...payload, requestId }));
      void markDeviceCommandDispatched(requestId).catch(() => undefined);
    } catch {
      pendingCommands.delete(requestId);
      clearTimeout(timeout);
      void markCommandUnknown(requestId, "The command could not be confirmed after dispatch. The outcome is unknown.");
      pending.resolve({ accepted: false, message: "The Android device command could not be confirmed after dispatch. The outcome is unknown; do not automatically retry a side-effecting action.", data: { outcome: "unknown", retryable: false, reason: "dispatch_error" } });
    }
  });
}

const commandRequestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_COMMAND_RESULT_MESSAGE_LENGTH = 4000;
const MAX_COMMAND_RESULT_DATA_BYTES = 64 * 1024;

export async function handleDeviceCommandResult(clientId: string, message: FroshDeviceCommand & { type: "device.command.result" }) {
  if (!message || message.type !== "device.command.result" || typeof message.requestId !== "string" || !commandRequestIdPattern.test(message.requestId) || typeof message.deviceId !== "string" || typeof message.accepted !== "boolean" || typeof message.message !== "string") return;
  if (message.message.length > MAX_COMMAND_RESULT_MESSAGE_LENGTH) return;
  let resultData: unknown = undefined;
  if ("data" in message && message.data !== undefined) {
    try {
      const serialized = JSON.stringify(message.data);
      if (serialized.length > MAX_COMMAND_RESULT_DATA_BYTES) return;
      resultData = message.data;
    } catch {
      return;
    }
  }
  const client = clients.get(clientId);
  if (
    !client ||
    client.deviceId !== message.deviceId ||
    client.socket.readyState !== WebSocket.OPEN ||
    latestClientByDevice.get(message.deviceId) !== clientId
  ) return;

  const pending = pendingCommands.get(message.requestId);
  const ledger = await getDeviceCommandLedger(message.requestId).catch(() => null);
  if (!ledger || ledger.deviceId !== message.deviceId || ledger.command !== message.command) return;
  if (ledger.state === "completed") return;

  if (pending && (pending.clientId !== clientId || pending.deviceId !== message.deviceId || pending.command !== message.command)) return;

  const result = {
    accepted: message.accepted,
    message: message.message,
    data: resultData,
  };
  const stored = await completeDeviceCommandLedger(message.requestId, result).catch(() => false);
  if (!stored) {
    const current = await getDeviceCommandLedger(message.requestId).catch(() => null);
    if (!pending) return;
    pendingCommands.delete(message.requestId);
    clearTimeout(pending.timeout);
    if (current?.state === "completed") {
      pending.resolve({
        accepted: current.accepted === true,
        message: current.message ?? "The command result was recovered from durable storage.",
        data: current.data,
      });
    } else {
      pending.resolve({
        accepted: false,
        message: "The Android command result could not be durably recorded. The outcome is unknown; do not automatically retry a side-effecting action.",
        data: { outcome: "unknown", retryable: false, reason: "ledger_completion_failed" },
      });
    }
    return;
  }

  if (!pending) return;
  pendingCommands.delete(message.requestId);
  clearTimeout(pending.timeout);
  pending.resolve(result);
}
export async function sendMessageCommand(deviceId: string, recipient: string, message: string, provider = "sms", idempotencyKey?: string) {
  const client = await getAuthenticatedCommandClient(deviceId);
  if (!client) return { accepted: false, message: "The Android device is not connected or its credential is no longer valid." };
  const latestId = client.id;
  if (!validCommandText(provider, MAX_PROVIDER_LENGTH) || !validCommandText(recipient, MAX_MESSAGE_RECIPIENT_LENGTH) || !validCommandText(message, MAX_MESSAGE_BODY_LENGTH)) {
    return { accepted: false, message: "Message command payload is too large." };
  }
  const requestId = crypto.randomUUID();
  const payload = { type: "device.command", deviceId, command: "send_message", provider, recipient, message };
  const ledger = await prepareCommandLedger({ requestId, deviceId, command: "send_message", payload, idempotencyKey });
  if (ledger.kind === "completed") return ledger.result;
  if (ledger.kind !== "new") return { accepted: false, message: ledger.kind === "unknown" ? "This idempotency key already has an unresolved message outcome. Do not automatically retry it." : "The message command could not be safely recorded or the idempotency key conflicts with another command.", data: { outcome: "unknown", retryable: false, reason: ledger.reason } };
  return new Promise<DeviceCommandResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const pending = pendingCommands.get(requestId);
      if (!pending) return;
      pendingCommands.delete(requestId);
      void markCommandUnknown(requestId, "The Android device did not acknowledge the message command before the server timeout. The outcome is unknown.");
      pending.resolve(commandTimeoutResult);
    }, 15000);
    pendingCommands.set(requestId, { clientId: latestId, deviceId, command: "send_message", resolve, reject, timeout });
    try {
      client.socket.send(JSON.stringify({ ...payload, requestId }));
      void markDeviceCommandDispatched(requestId).catch(() => undefined);
    } catch {
      pendingCommands.delete(requestId);
      clearTimeout(timeout);
      void markCommandUnknown(requestId, "The message command could not be confirmed after dispatch. The outcome is unknown.");
      pending.resolve({ accepted: false, message: "The Android device command could not be confirmed after dispatch. The outcome is unknown; do not automatically retry a side-effecting action.", data: { outcome: "unknown", retryable: false, reason: "dispatch_error" } });
    }
  });
}

export function requestMessageInbox(deviceId: string) {
  return sendDeviceCommand(deviceId, "message_inbox");
}

export async function replyToMessageCommand(deviceId: string, notificationId: string, message: string, idempotencyKey?: string) {
  const client = await getAuthenticatedCommandClient(deviceId);
  if (!client) return { accepted: false, message: "The Android device is not connected or its credential is no longer valid." };
  const latestId = client.id;
  if (!validCommandText(notificationId, MAX_NOTIFICATION_ID_LENGTH) || !validCommandText(message, MAX_MESSAGE_BODY_LENGTH)) {
    return { accepted: false, message: "Message reply payload is too large." };
  }
  const requestId = crypto.randomUUID();
  const payload = { type: "device.command", deviceId, command: "message_reply", notificationId, message };
  const ledger = await prepareCommandLedger({ requestId, deviceId, command: "message_reply", payload, idempotencyKey });
  if (ledger.kind === "completed") return ledger.result;
  if (ledger.kind !== "new") return { accepted: false, message: ledger.kind === "unknown" ? "This idempotency key already has an unresolved reply outcome. Do not automatically retry it." : "The reply command could not be safely recorded or the idempotency key conflicts with another command.", data: { outcome: "unknown", retryable: false, reason: ledger.reason } };
  return new Promise<DeviceCommandResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const pending = pendingCommands.get(requestId);
      if (!pending) return;
      pendingCommands.delete(requestId);
      void markCommandUnknown(requestId, "The Android device did not acknowledge the reply command before the server timeout. The outcome is unknown.");
      pending.resolve(commandTimeoutResult);
    }, 15000);
    pendingCommands.set(requestId, { clientId: latestId, deviceId, command: "message_reply", resolve, reject, timeout });
    try {
      client.socket.send(JSON.stringify({ ...payload, requestId }));
      void markDeviceCommandDispatched(requestId).catch(() => undefined);
    } catch {
      pendingCommands.delete(requestId);
      clearTimeout(timeout);
      void markCommandUnknown(requestId, "The reply command could not be confirmed after dispatch. The outcome is unknown.");
      pending.resolve({ accepted: false, message: "The Android device command could not be confirmed after dispatch. The outcome is unknown; do not automatically retry a side-effecting action.", data: { outcome: "unknown", retryable: false, reason: "dispatch_error" } });
    }
  });
}

export function requestMessageIntelligence(deviceId: string) {
  return sendDeviceCommand(deviceId, "message_inbox");
}
