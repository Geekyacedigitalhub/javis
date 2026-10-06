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

type CommandRecordBase = { createdAt: number; command: string; deviceId?: string; payloadHash?: string };
type CommandRecord =
  | ({ state: "started" } & CommandRecordBase)
  | ({ state: "completed"; accepted: boolean; message: string; data?: unknown } & CommandRecordBase);

const commandRecords = new Map<string, CommandRecord>();
const inFlightCommands = new Map<string, Promise<void>>();
const commandRecordWrites = new Map<string, Promise<void>>();
const commandRecordPrefix = "frosh:device-command:";
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isSafeCommandRequestId(value: string): boolean {
  return requestIdPattern.test(value);
}

async function hashCommandPayload(command: Record<string, unknown>): Promise<string> {
  const payload = Object.keys(command)
    .filter((key) => key !== "requestId")
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = command[key];
      return result;
    }, {});
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseCommandRecord(raw: string): CommandRecord {
  const parsed = JSON.parse(raw) as Partial<CommandRecord>;
  if (
    !parsed ||
    (parsed.state !== "started" && parsed.state !== "completed") ||
    typeof parsed.createdAt !== "number" ||
    !Number.isFinite(parsed.createdAt) ||
    parsed.createdAt <= 0 ||
    typeof parsed.command !== "string" ||
    !parsed.command.trim()
  ) {
    // Never delete malformed command history: corruption is not proof that the
    // side-effect did not start. Fail closed so a duplicate cannot execute it.
    throw new Error("Durable command record is invalid");
  }
  return parsed as CommandRecord;
}

async function readDurableCommandRecord(requestId: string): Promise<CommandRecord | null> {
  const raw = await SecureStore.getItemAsync(commandRecordPrefix + requestId);
  return raw ? parseCommandRecord(raw) : null;
}

async function loadCommandRecord(requestId: string): Promise<CommandRecord | null> {
  const cached = commandRecords.get(requestId);
  if (cached) return cached;
  try {
    const parsed = await readDurableCommandRecord(requestId);
    if (parsed) commandRecords.set(requestId, parsed);
    return parsed;
  } catch (error) {
    throw new Error("Durable command record storage is unavailable", { cause: error });
  }
}

async function saveCommandRecord(requestId: string, record: CommandRecord) {
  const previousWrite = commandRecordWrites.get(requestId) ?? Promise.resolve();
  let release!: () => void;
  const currentWrite = new Promise<void>((resolve) => { release = resolve; });
  commandRecordWrites.set(requestId, currentWrite);
  await previousWrite;

  try {
    const existing = await readDurableCommandRecord(requestId);
    if (existing) {
      const sameIdentity =
        existing.command === record.command &&
        (!existing.deviceId || !record.deviceId || existing.deviceId === record.deviceId) &&
        (!existing.payloadHash || !record.payloadHash || existing.payloadHash === record.payloadHash);

      if (!sameIdentity) return false;

      if (existing.state === "completed") {
        // A completed record is immutable. Never replace an authoritative result.
        commandRecords.set(requestId, existing);
        return false;
      }

      if (record.state === "started") {
        // Idempotent re-save of the same started fence.
        commandRecords.set(requestId, existing);
        return true;
      }

      // A started fence may transition exactly once to a completed result.
    }

    await SecureStore.setItemAsync(commandRecordPrefix + requestId, JSON.stringify(record));
    commandRecords.set(requestId, record);
    return true;
  } catch {
    return false;
  } finally {
    if (commandRecordWrites.get(requestId) === currentWrite) {
      commandRecordWrites.delete(requestId);
    }
    release();
  }
}

async function sendUnknownCommandResult(
  socket: WebSocket,
  command: Record<string, unknown>,
  reason: string,
  message: string,
) {
  try {
    socket.send(JSON.stringify({
      type: "device.command.result",
      requestId: String(command.requestId ?? ""),
      deviceId: String(command.deviceId ?? ""),
      command: String(command.command ?? ""),
      accepted: false,
      message,
      data: { outcome: "unknown", retryable: false, reason },
    }));
  } catch {
    // The server will treat a missing acknowledgement as unknown.
  }
}

async function sendStoredCommandResult(
  socket: WebSocket,
  command: Record<string, unknown>,
  record: Extract<CommandRecord, { state: "completed" }>,
) {
  try {
    socket.send(JSON.stringify({
      type: "device.command.result",
      requestId: String(command.requestId ?? ""),
      deviceId: String(command.deviceId ?? ""),
      command: record.command,
      accepted: record.accepted,
      message: record.message,
      ...(record.data !== undefined ? { data: record.data } : {}),
    }));
  } catch {
    // The durable result is already authoritative; a later duplicate can replay it.
  }
}

async function sendCommandResult(
  socket: WebSocket,
  command: Record<string, unknown>,
  result: { accepted: boolean; message: string; data?: unknown },
) {
  const requestId = String(command.requestId ?? "");
  const deviceId = String(command.deviceId ?? "");
  const commandType = String(command.command ?? "");
  const payloadHash = await hashCommandPayload(command);

  let existing: CommandRecord | null;
  try {
    existing = await loadCommandRecord(requestId);
  } catch {
    await sendUnknownCommandResult(
      socket,
      command,
      "command_record_read_failed",
      "The Android device could not verify its durable command history. The final outcome is unknown; do not retry automatically.",
    );
    return;
  }

  const sameIdentity = (record: CommandRecord) =>
    record.command === commandType &&
    (!record.deviceId || record.deviceId === deviceId) &&
    (!record.payloadHash || record.payloadHash === payloadHash);

  if (existing?.state === "completed") {
    if (sameIdentity(existing)) {
      await sendStoredCommandResult(socket, command, existing);
    } else {
      await sendUnknownCommandResult(
        socket,
        command,
        "request_id_command_mismatch",
        "This request ID is already fenced by a different command. The outcome is unknown; do not execute automatically.",
      );
    }
    return;
  }

  if (!existing || existing.state !== "started" || !sameIdentity(existing)) {
    await sendUnknownCommandResult(
      socket,
      command,
      "command_record_fence_missing",
      "The Android device could not verify the matching started command fence. The outcome is unknown; do not retry automatically.",
    );
    return;
  }

  const record: Extract<CommandRecord, { state: "completed" }> = {
    state: "completed",
    // Preserve the original fence timestamp so the completed record remains
    // permanently tied to the exact execution fence that preceded the side effect.
    createdAt: existing.createdAt,
    command: commandType,
    deviceId,
    payloadHash,
    accepted: result.accepted,
    message: result.message,
    data: result.data,
  };

  const persisted = await saveCommandRecord(requestId, record);
  if (!persisted) {
    await sendUnknownCommandResult(
      socket,
      command,
      "command_result_persist_failed",
      "The command completed but its final outcome could not be durably recorded. The outcome is unknown; do not automatically retry the side-effecting action.",
    );
    return;
  }
  const stored = await loadCommandRecord(requestId);
  if (stored?.state === "completed") {
    await sendStoredCommandResult(socket, command, stored);
    return;
  }
  await sendUnknownCommandResult(
    socket,
    command,
    "command_result_read_failed",
    "The command result was persisted but could not be re-read as a completed durable record. The outcome is unknown; do not automatically retry the side-effecting action.",
  );
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
        if (!isSafeCommandRequestId(requestId) || !commandDeviceId || !authenticatedDeviceId || commandDeviceId !== authenticatedDeviceId) {
          return;
        }
        commandRequestId = requestId;
          const commandType = typeof parsed.command === "string" ? parsed.command : "";
          if (!commandType) return;
          const payloadHash = await hashCommandPayload(parsed);
          const existingInFlight = inFlightCommands.get(requestId);
          if (existingInFlight) {
            await existingInFlight;
            try {
              const completed = await loadCommandRecord(requestId);
              if (completed?.state === "completed" && completed.command === commandType && (!completed.deviceId || completed.deviceId === authenticatedDeviceId) && (!completed.payloadHash || completed.payloadHash === payloadHash)) {
                await sendStoredCommandResult(socket, parsed, completed);
              } else {
                await sendUnknownCommandResult(
                  socket,
                  parsed,
                  "prior_execution_unknown",
                  "This command was already processed by another connection, but its final outcome was not durably recorded. The outcome is unknown; do not retry automatically.",
                );
              }
            } catch {
              await sendUnknownCommandResult(
                socket,
                parsed,
                "command_record_read_failed",
                "The Android device could not verify the prior command outcome. The outcome is unknown; do not retry automatically.",
              );
            }
            return;
          }

          let release!: () => void;
          const lock = new Promise<void>((resolve) => { release = resolve; });
          inFlightCommands.set(requestId, lock);
          releaseCommand = release;

          try {
            const existing = await loadCommandRecord(requestId);
            if (existing?.state === "completed" && existing.command === commandType && (!existing.deviceId || existing.deviceId === authenticatedDeviceId) && (!existing.payloadHash || existing.payloadHash === payloadHash)) {
              await sendStoredCommandResult(socket, parsed, existing);
              inFlightCommands.delete(requestId);
              releaseCommand();
              return;
            }
            if (existing?.state === "completed" && existing.command !== commandType) {
              await sendUnknownCommandResult(
                socket,
                parsed,
                "request_id_command_mismatch",
                "This request ID was previously used for a different command. The outcome is unknown; do not execute automatically.",
              );
              inFlightCommands.delete(requestId);
              releaseCommand();
              return;
            }
            if (existing?.state === "started") {
              if (
                existing.command !== commandType ||
                (existing.deviceId && existing.deviceId !== authenticatedDeviceId) ||
                (existing.payloadHash && existing.payloadHash !== payloadHash)
              ) {
                await sendUnknownCommandResult(
                  socket,
                  parsed,
                  "request_id_command_mismatch",
                  "This request ID was previously started for a different command. The outcome is unknown; do not execute automatically.",
                );
              } else {
                await sendUnknownCommandResult(
                  socket,
                  parsed,
                  "prior_execution_started",
                  "This command was already started before this connection began. The outcome is unknown; do not retry automatically.",
                );
              }
              inFlightCommands.delete(requestId);
              releaseCommand();
              return;
            }
            const startedPersisted = await saveCommandRecord(requestId, { state: "started", command: commandType, deviceId: authenticatedDeviceId, payloadHash, createdAt: Date.now() });
            if (!startedPersisted) {
              await sendUnknownCommandResult(
                socket,
                parsed,
                "command_record_persist_failed",
                "The Android device could not durably record this command before execution. The action was not started; do not retry automatically until storage is healthy.",
              );
              inFlightCommands.delete(requestId);
              releaseCommand();
              return;
            }
          } catch {
            await sendUnknownCommandResult(
              socket,
              parsed,
              "command_record_read_failed",
              "The Android device could not verify its durable command history. The action was not started; do not retry until storage is healthy.",
            );
            inFlightCommands.delete(requestId);
            releaseCommand();
            return;
          }
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
