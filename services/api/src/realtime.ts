import type { FroshEvent } from "../../../packages/types/src/events";
import type { FroshDeviceCommand } from "../../../packages/types/src/events";

type Client = {
  id: string;
  socket: WebSocket;
  deviceId?: string;
};

const clients = new Map<string, Client>();

export function addRealtimeClient(socket: WebSocket, deviceId?: string) {
  const id = crypto.randomUUID();
  clients.set(id, { id, socket, deviceId });

  socket.addEventListener("close", () => {
    clients.delete(id);
    for (const [requestId, pending] of pendingCommands) {
      if (pending.deviceId !== deviceId) continue;
      pendingCommands.delete(requestId);
      pending.resolve({
        accepted: false,
        message: "The Android device disconnected before acknowledging the command. The outcome is unknown; do not automatically retry a side-effecting action.",
        data: { outcome: "unknown", retryable: false, reason: "device_disconnected" },
      });
    }
  });
  return id;
}

export function removeRealtimeClient(id: string) {
  clients.delete(id);
}

export function broadcast(event: FroshEvent) {
  const payload = JSON.stringify(event);
  for (const client of clients.values()) {
    if (client.socket.readyState === WebSocket.OPEN) client.socket.send(payload);
  }
}

export function realtimeClientCount() {
  return clients.size;
}

type DeviceCommandResult = { accepted: boolean; message: string; data?: unknown };

type PendingCommand = {
  deviceId: string;
  resolve: (value: DeviceCommandResult) => void;
  reject: (error: Error) => void;
};

const pendingCommands = new Map<string, PendingCommand>();

const commandTimeoutResult = {
  accepted: false,
  message: "The Android device did not acknowledge the command. The outcome is unknown; do not automatically retry a side-effecting action.",
  data: { outcome: "unknown", retryable: false },
};

export function sendDeviceCommand(deviceId: string, command: Extract<FroshDeviceCommand, { type: "device.command" }>["command"], value?: string) {
  const client = [...clients.values()].find((item) => item.deviceId === deviceId);
  if (!client || client.socket.readyState !== WebSocket.OPEN) {
    return Promise.resolve({ accepted: false, message: "The Android device is not connected." });
  }
  const requestId = crypto.randomUUID();
  return new Promise<DeviceCommandResult>((resolve, reject) => {
    pendingCommands.set(requestId, { deviceId, resolve, reject });
    try {
      client.socket.send(JSON.stringify({ type: "device.command", requestId, deviceId, command, ...(command === "open_app" ? { appName: value } : command === "media_control" ? { action: value } : command === "contacts_search" ? { query: value } : command === "call_number" ? { phoneNumber: value } : {}) }));
    } catch (error) {
      pendingCommands.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    setTimeout(() => {
      const pending = pendingCommands.get(requestId);
      if (!pending) return;
      pendingCommands.delete(requestId);
      pending.resolve(commandTimeoutResult);
    }, 15000);
  });
}

export function handleDeviceCommandResult(message: FroshDeviceCommand & { type: "device.command.result" }) {
  const pending = pendingCommands.get(message.requestId);
  if (!pending) return;
  if (pending.deviceId !== message.deviceId) return;
  pendingCommands.delete(message.requestId);
  pending.resolve({
    accepted: message.accepted,
    message: message.message,
    data: "data" in message ? message.data : undefined,
  });
}

export function sendMessageCommand(deviceId: string, recipient: string, message: string, provider = "sms") {
  const client = [...clients.values()].find((item) => item.deviceId === deviceId);
  if (!client || client.socket.readyState !== WebSocket.OPEN) {
    return Promise.resolve({ accepted: false, message: "The Android device is not connected." });
  }
  const requestId = crypto.randomUUID();
  return new Promise<DeviceCommandResult>((resolve, reject) => {
    pendingCommands.set(requestId, { deviceId, resolve, reject });
    try {
      client.socket.send(JSON.stringify({ type: "device.command", requestId, deviceId, command: "send_message", provider, recipient, message }));
    } catch (error) {
      pendingCommands.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    setTimeout(() => {
      const pending = pendingCommands.get(requestId);
      if (!pending) return;
      pendingCommands.delete(requestId);
      pending.resolve(commandTimeoutResult);
    }, 15000);
  });
}

export function requestMessageInbox(deviceId: string) {
  return sendDeviceCommand(deviceId, "message_inbox");
}

export function replyToMessageCommand(deviceId: string, notificationId: string, message: string) {
  const client = [...clients.values()].find((item) => item.deviceId === deviceId);
  if (!client || client.socket.readyState !== WebSocket.OPEN) return Promise.resolve({ accepted: false, message: "The Android device is not connected." });
  const requestId = crypto.randomUUID();
  return new Promise<DeviceCommandResult>((resolve, reject) => {
    pendingCommands.set(requestId, { deviceId, resolve, reject });
    try {
      client.socket.send(JSON.stringify({ type: "device.command", requestId, deviceId, command: "message_reply", notificationId, message }));
    } catch (error) {
      pendingCommands.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    setTimeout(() => {
      const pending = pendingCommands.get(requestId);
      if (!pending) return;
      pendingCommands.delete(requestId);
      pending.resolve(commandTimeoutResult);
    }, 15000);
  });
}

export function requestMessageIntelligence(deviceId: string) {
  return sendDeviceCommand(deviceId, "message_inbox");
}
