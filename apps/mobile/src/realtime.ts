import * as SecureStore from "expo-secure-store";
import type { FroshEvent } from "../../../packages/types/src/events";
import { FROSH_API_URL } from "./api";
import { loadDeviceCredential } from "./session";
import { launchAppByName } from "../modules/frosh-apps/src";
import { executeMediaAction } from "./media";
import { searchContacts } from "../modules/frosh-contacts/src";
import { executePhoneAction } from "./phone-actions";

function websocketUrl() {
  return FROSH_API_URL.replace(/^http/, "ws") + "/v1/realtime";
}

type CommandRecord =
  | { state: "started"; createdAt: number }
  | { state: "completed"; createdAt: number; accepted: boolean; message: string; data?: unknown };

const commandRecords = new Map<string, CommandRecord>();
const inFlightCommands = new Map<string, Promise<void>>();
const commandRecordPrefix = "frosh:device-command:";

async function loadCommandRecord(requestId: string): Promise<CommandRecord | null> {
  const cached = commandRecords.get(requestId);
  if (cached) return cached;
  try {
    const raw = await SecureStore.getItemAsync(commandRecordPrefix + requestId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CommandRecord;
    if (!parsed || typeof parsed.createdAt !== "number" || Date.now() - parsed.createdAt > 24 * 60 * 60 * 1000) {
      await SecureStore.deleteItemAsync(commandRecordPrefix + requestId).catch(() => undefined);
      return null;
    }
    commandRecords.set(requestId, parsed);
    return parsed;
  } catch {
    return null;
  }
}

async function saveCommandRecord(requestId: string, record: CommandRecord) {
  commandRecords.set(requestId, record);
  try {
    await SecureStore.setItemAsync(commandRecordPrefix + requestId, JSON.stringify(record));
  } catch {}
}

async function sendCommandResult(
  socket: WebSocket,
  command: Record<string, unknown>,
  result: { accepted: boolean; message: string; data?: unknown },
) {
  const requestId = String(command.requestId ?? "");
  const deviceId = String(command.deviceId ?? "");
  const record: CommandRecord = { state: "completed", createdAt: Date.now(), accepted: result.accepted, message: result.message, data: result.data };
  await saveCommandRecord(requestId, record);
  socket.send(JSON.stringify({
    type: "device.command.result",
    requestId,
    deviceId,
    accepted: result.accepted,
    message: result.message,
    ...(result.data !== undefined ? { data: result.data } : {}),
  }));
}

export function connectFroshRealtime(
  onEvent: (event: FroshEvent) => void,
  onStatus?: (status: "connecting" | "open" | "closed") => void,
) {
  onStatus?.("connecting");
  const socket = new WebSocket(websocketUrl());
  let authenticatedDeviceId: string | undefined;

  socket.onopen = async () => {
    const credential = await loadDeviceCredential();
    if (!credential) {
      onStatus?.("closed");
      socket.close();
      return;
    }
    authenticatedDeviceId = credential.deviceId;
    socket.send(JSON.stringify({
      type: "auth",
      deviceId: credential.deviceId,
      token: credential.token
    }));
    onStatus?.("open");
  };
  socket.onmessage = async (message) => {
    try {
      const parsed = JSON.parse(message.data) as Record<string, unknown>;
      let releaseCommand: (() => void) | undefined;
      let commandRequestId: string | undefined;

      if (parsed.type === "device.command") {
        const requestId = typeof parsed.requestId === "string" ? parsed.requestId.trim() : "";
        const commandDeviceId = typeof parsed.deviceId === "string" ? parsed.deviceId.trim() : "";
        if (!requestId || !commandDeviceId || !authenticatedDeviceId || commandDeviceId !== authenticatedDeviceId) {
          return;
        }
        commandRequestId = requestId;
          const existingInFlight = inFlightCommands.get(requestId);
          if (existingInFlight) {
            await existingInFlight;
            const completed = await loadCommandRecord(requestId);
            if (completed?.state === "completed") {
              await sendCommandResult(socket, parsed, completed);
            } else {
              await sendCommandResult(socket, parsed, {
                accepted: false,
                message: "This command was already processed by another connection, but its final outcome was not durably recorded. The outcome is unknown; do not retry automatically.",
                data: { outcome: "unknown", retryable: false, reason: "prior_execution_unknown" },
              });
            }
            return;
          }

          let release!: () => void;
          const lock = new Promise<void>((resolve) => { release = resolve; });
          inFlightCommands.set(requestId, lock);
          releaseCommand = release;

          const existing = await loadCommandRecord(requestId);
          if (existing?.state === "completed") {
            await sendCommandResult(socket, parsed, existing);
            inFlightCommands.delete(requestId);
            releaseCommand();
            return;
          }
          if (existing?.state === "started") {
            await sendCommandResult(socket, parsed, {
              accepted: false,
              message: "This command was already started before this connection began. The outcome is unknown; do not retry automatically.",
              data: { outcome: "unknown", retryable: false, reason: "prior_execution_started" },
            });
            inFlightCommands.delete(requestId);
            releaseCommand();
            return;
          }
          await saveCommandRecord(requestId, { state: "started", createdAt: Date.now() });
      }

      try {
      if (parsed.type === "device.command" && parsed.command === "message_inbox") {
        try {
          const { getUnifiedMessagingInbox } = await import("./messaging-inbox");
          const inbox = await getUnifiedMessagingInbox();
          await sendCommandResult(socket, parsed, { accepted: true, message: "Message inbox loaded.", data: inbox });
        } catch (error) {
          await sendCommandResult(socket, parsed, { accepted: false, message: error instanceof Error ? error.message : "Unable to load the message inbox." });
        }
        return;
      }

      if (parsed.type === "device.command" && parsed.command === "message_reply") {
        try {
          const { replyToUnifiedMessage } = await import("./messaging-inbox");
          const result = await replyToUnifiedMessage(String(parsed.notificationId ?? ""), String(parsed.message ?? ""));
          await sendCommandResult(socket, parsed, { accepted: result.accepted, message: result.message });
        } catch (error) {
          await sendCommandResult(socket, parsed, { accepted: false, message: error instanceof Error ? error.message : "Unable to reply to the message." });
        }
        return;
      }

      if (parsed.type === "device.command" && parsed.command === "send_message") {
        try {
          const result = await executePhoneAction({ action: "compose_message", value: String(parsed.recipient ?? ""), message: String(parsed.message ?? "") } as never);
          await sendCommandResult(socket, parsed, { accepted: result.accepted, message: result.message });
        } catch (error) {
          await sendCommandResult(socket, parsed, { accepted: false, message: error instanceof Error ? error.message : "Unable to send the message." });
        }
        return;
      }
      if (parsed.type === "device.command" && (parsed.command === "open_dialer" || parsed.command === "call_number")) {
        const result = await executePhoneAction({ action: parsed.command, value: typeof parsed.phoneNumber === "string" ? parsed.phoneNumber : undefined } as never);
        await sendCommandResult(socket, parsed, { accepted: result.accepted, message: result.message });
        return;
      }
      if (parsed.type === "device.command" && parsed.command === "contacts_search") {
        const contacts = searchContacts(String(parsed.query ?? ""));
        await sendCommandResult(socket, parsed, { accepted: true, message: contacts.length ? "Contact search completed." : "No matching contacts found.", data: contacts });
        return;
      }
      if (parsed.type === "device.command" && parsed.command === "media_state") {
        const state = await (async () => {
          try {
            const module = require("../modules/frosh-media/src").default;
            return await module.getState();
          } catch {
            return { available: false, message: "Media native module unavailable." };
          }
        })();
        await sendCommandResult(socket, parsed, {
          accepted: Boolean(state.available),
          message: state.message ?? (state.available ? "Current media state retrieved." : "No active media session."),
          data: state
        });
        return;
      }
      if (parsed.type === "device.command" && parsed.command === "media_control") {
        const result = await executeMediaAction({ action: String(parsed.action ?? "play") } as any);
        await sendCommandResult(socket, parsed, { accepted: result.accepted, message: result.message });
        return;
      }
      if (parsed.type === "device.command" && parsed.command === "open_app") {
        const result = launchAppByName(String(parsed.appName ?? ""));
        await sendCommandResult(socket, parsed, { accepted: result.accepted, message: result.message });
        return;
      }
      if (parsed.type === "connected") {
        onStatus?.("open");
        return;
      }
      onEvent(parsed as unknown as FroshEvent);
      } catch (error) {
        if (commandRequestId) {
          await sendCommandResult(socket, parsed, {
            accepted: false,
            message: error instanceof Error
              ? `The Android command failed before a definitive outcome could be confirmed: ${error.message}`
              : "The Android command failed before a definitive outcome could be confirmed. The outcome is unknown; do not retry automatically.",
            data: { outcome: "unknown", retryable: false, reason: "command_execution_exception" },
          }).catch(() => undefined);
        }
      } finally {
        if (commandRequestId) {
          inFlightCommands.delete(commandRequestId);
          releaseCommand?.();
        }
      }
    } catch {
      // Ignore malformed events from the server.
    }
  };
  socket.onerror = () => onStatus?.("closed");
  socket.onclose = () => onStatus?.("closed");

  return () => socket.close();
}
