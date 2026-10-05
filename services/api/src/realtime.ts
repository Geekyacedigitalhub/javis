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

  socket.addEventListener("close", () => clients.delete(id));
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

const pendingCommands = new Map<string, { resolve: (value: { accepted: boolean; message: string; data?: unknown }) => void; reject: (error: Error) => void }>();

export function sendDeviceCommand(deviceId: string, command: Extract<FroshDeviceCommand, { type: "device.command" }>["command"], value?: string) {
  const client = [...clients.values()].find((item) => item.deviceId === deviceId);
  if (!client || client.socket.readyState !== WebSocket.OPEN) {
    return Promise.resolve({ accepted: false, message: "The Android device is not connected." });
  }
  const requestId = crypto.randomUUID();
  client.socket.send(JSON.stringify({ type: "device.command", requestId, deviceId, command, ...(command === "open_app" ? { appName: value } : command === "media_control" ? { action: value } : command === "contacts_search" ? { query: value } : command === "call_number" ? { phoneNumber: value } : {}) }));
  return new Promise<{ accepted: boolean; message: string }>((resolve, reject) => {
    pendingCommands.set(requestId, { resolve, reject });
    setTimeout(() => {
      const pending = pendingCommands.get(requestId);
      if (!pending) return;
      pendingCommands.delete(requestId);
      pending.resolve({ accepted: false, message: "The Android device did not respond in time." });
    }, 15000);
  });
}

export function handleDeviceCommandResult(message: FroshDeviceCommand & { type: "device.command.result" }) {
  const pending = pendingCommands.get(message.requestId);
  if (!pending) return;
  pendingCommands.delete(message.requestId);
  pending.resolve({ accepted: message.accepted, message: message.message, data: "data" in message ? message.data : undefined });
}

export function sendMessageCommand(deviceId: string, recipient: string, message: string, provider = "sms") {
  const client = [...clients.values()].find((item) => item.deviceId === deviceId);
  if (!client || client.socket.readyState !== WebSocket.OPEN) {
    return Promise.resolve({ accepted: false, message: "The Android device is not connected." });
  }
  const requestId = crypto.randomUUID();
  client.socket.send(JSON.stringify({ type: "device.command", requestId, deviceId, command: "send_message", provider, recipient, message }));
  return new Promise<{ accepted: boolean; message: string; data?: unknown }>((resolve) => {
    pendingCommands.set(requestId, { resolve, reject: () => undefined });
    setTimeout(() => {
      const pending = pendingCommands.get(requestId);
      if (!pending) return;
      pendingCommands.delete(requestId);
      resolve({ accepted: false, message: "The Android device did not respond in time." });
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
  client.socket.send(JSON.stringify({ type: "device.command", requestId, deviceId, command: "message_reply", notificationId, message }));
  return new Promise<{ accepted: boolean; message: string; data?: unknown }>((resolve) => {
    pendingCommands.set(requestId, { resolve, reject: () => undefined });
    setTimeout(() => {
      const pending = pendingCommands.get(requestId);
      if (!pending) return;
      pendingCommands.delete(requestId);
      resolve({ accepted: false, message: "The Android device did not respond in time." });
    }, 15000);
  });
}
