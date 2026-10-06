import type { FroshEvent } from "../../../packages/types/src/events";
import type { FroshDeviceCommand } from "../../../packages/types/src/events";
import { authenticateDevice, markDeviceOffline } from "./devices";

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
  if (deviceId) latestClientByDevice.set(deviceId, id);

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

export function sendToDevice(deviceId: string, event: FroshEvent) {
  const clientId = latestClientByDevice.get(deviceId);
  if (!clientId) return false;
  const client = clients.get(clientId);
  if (!client || client.deviceId !== deviceId || client.socket.readyState !== WebSocket.OPEN) return false;
  client.socket.send(JSON.stringify(event));
  return true;
}

export function realtimeClientCount() {
  return clients.size;
}

type DeviceCommandResult = { accepted: boolean; message: string; data?: unknown };

type PendingCommand = {
  clientId: string;
  deviceId: string;
  resolve: (value: DeviceCommandResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const pendingCommands = new Map<string, PendingCommand>();

const commandTimeoutResult = {
  accepted: false,
  message: "The Android device did not acknowledge the command. The outcome is unknown; do not automatically retry a side-effecting action.",
  data: { outcome: "unknown", retryable: false },
};

export function sendDeviceCommand(deviceId: string, command: Extract<FroshDeviceCommand, { type: "device.command" }>["command"], value?: string) {
  const latestId = latestClientByDevice.get(deviceId);
  const client = latestId ? clients.get(latestId) : undefined;
  if (!client || client.socket.readyState !== WebSocket.OPEN) {
    return Promise.resolve({ accepted: false, message: "The Android device is not connected." });
  }
  const requestId = crypto.randomUUID();
  return new Promise<DeviceCommandResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const pending = pendingCommands.get(requestId);
      if (!pending) return;
      pendingCommands.delete(requestId);
      pending.resolve(commandTimeoutResult);
    }, 15000);
    pendingCommands.set(requestId, { clientId: latestId, deviceId, resolve, reject, timeout });
    try {
      client.socket.send(JSON.stringify({ type: "device.command", requestId, deviceId, command, ...(command === "open_app" ? { appName: value } : command === "media_control" ? { action: value } : command === "contacts_search" ? { query: value } : command === "call_number" ? { phoneNumber: value } : {}) }));
    } catch (error) {
      pendingCommands.delete(requestId);
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
  });
}

export function handleDeviceCommandResult(clientId: string, message: FroshDeviceCommand & { type: "device.command.result" }) {
  if (!message || message.type !== "device.command.result" || typeof message.requestId !== "string" || typeof message.deviceId !== "string" || typeof message.accepted !== "boolean" || typeof message.message !== "string") return;
  const pending = pendingCommands.get(message.requestId);
  if (!pending) return;
  if (pending.clientId !== clientId || pending.deviceId !== message.deviceId) return;
  pendingCommands.delete(message.requestId);
  clearTimeout(pending.timeout);
  pending.resolve({
    accepted: message.accepted,
    message: message.message,
    data: "data" in message ? message.data : undefined,
  });
}

export function sendMessageCommand(deviceId: string, recipient: string, message: string, provider = "sms") {
  const latestId = latestClientByDevice.get(deviceId);
  const client = latestId ? clients.get(latestId) : undefined;
  if (!client || client.socket.readyState !== WebSocket.OPEN) {
    return Promise.resolve({ accepted: false, message: "The Android device is not connected." });
  }
  const requestId = crypto.randomUUID();
  return new Promise<DeviceCommandResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const pending = pendingCommands.get(requestId);
      if (!pending) return;
      pendingCommands.delete(requestId);
      pending.resolve(commandTimeoutResult);
    }, 15000);
    pendingCommands.set(requestId, { clientId: latestId, deviceId, resolve, reject, timeout });
    try {
      client.socket.send(JSON.stringify({ type: "device.command", requestId, deviceId, command: "send_message", provider, recipient, message }));
    } catch (error) {
      pendingCommands.delete(requestId);
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
  });
}

export function requestMessageInbox(deviceId: string) {
  return sendDeviceCommand(deviceId, "message_inbox");
}

export function replyToMessageCommand(deviceId: string, notificationId: string, message: string) {
  const latestId = latestClientByDevice.get(deviceId);
  const client = latestId ? clients.get(latestId) : undefined;
  if (!client || client.socket.readyState !== WebSocket.OPEN) return Promise.resolve({ accepted: false, message: "The Android device is not connected." });
  const requestId = crypto.randomUUID();
  return new Promise<DeviceCommandResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const pending = pendingCommands.get(requestId);
      if (!pending) return;
      pendingCommands.delete(requestId);
      pending.resolve(commandTimeoutResult);
    }, 15000);
    pendingCommands.set(requestId, { clientId: latestId, deviceId, resolve, reject, timeout });
    try {
      client.socket.send(JSON.stringify({ type: "device.command", requestId, deviceId, command: "message_reply", notificationId, message }));
    } catch (error) {
      pendingCommands.delete(requestId);
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
  });
}

export function requestMessageIntelligence(deviceId: string) {
  return sendDeviceCommand(deviceId, "message_inbox");
}
