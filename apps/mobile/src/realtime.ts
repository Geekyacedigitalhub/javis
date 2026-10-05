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

export function connectFroshRealtime(
  onEvent: (event: FroshEvent) => void,
  onStatus?: (status: "connecting" | "open" | "closed") => void,
) {
  onStatus?.("connecting");
  const socket = new WebSocket(websocketUrl());

  socket.onopen = async () => {
    const credential = await loadDeviceCredential();
    if (!credential) {
      onStatus?.("closed");
      socket.close();
      return;
    }
    socket.send(JSON.stringify({
      type: "auth",
      deviceId: credential.deviceId,
      token: credential.token
    }));
    onStatus?.("open");
  };
  socket.onmessage = (message) => {
    try {
      const parsed = JSON.parse(message.data) as Record<string, unknown>;
      if (parsed.type === "device.command" && parsed.command === "send_message") {
        try {
          const result = await executePhoneAction({ action: "compose_message", value: String(parsed.phoneNumber ?? ""), message: String(parsed.message ?? "") } as never);
          socket.send(JSON.stringify({ type: "device.command.result", requestId: parsed.requestId, deviceId: parsed.deviceId, accepted: result.accepted, message: result.message }));
        } catch (error) {
          socket.send(JSON.stringify({ type: "device.command.result", requestId: parsed.requestId, deviceId: parsed.deviceId, accepted: false, message: error instanceof Error ? error.message : "Unable to send the message." }));
        }
        return;
      }
      if (parsed.type === "device.command" && (parsed.command === "open_dialer" || parsed.command === "call_number")) {
        const result = await executePhoneAction({ action: parsed.command, value: typeof parsed.phoneNumber === "string" ? parsed.phoneNumber : undefined } as never);
        socket.send(JSON.stringify({ type: "device.command.result", requestId: parsed.requestId, deviceId: parsed.deviceId, accepted: result.accepted, message: result.message }));
        return;
      }
      if (parsed.type === "device.command" && parsed.command === "contacts_search") {
        const contacts = searchContacts(String(parsed.query ?? ""));
        socket.send(JSON.stringify({ type: "device.command.result", requestId: parsed.requestId, deviceId: parsed.deviceId, accepted: true, message: contacts.length ? "Contact search completed." : "No matching contacts found.", data: contacts }));
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
        socket.send(JSON.stringify({
          type: "device.command.result",
          requestId: parsed.requestId,
          deviceId: parsed.deviceId,
          accepted: Boolean(state.available),
          message: state.message ?? (state.available ? "Current media state retrieved." : "No active media session."),
          data: state
        }));
        return;
      }
      if (parsed.type === "device.command" && parsed.command === "media_control") {
        const result = await executeMediaAction({ action: String(parsed.action ?? "play") } as any);
        socket.send(JSON.stringify({
          type: "device.command.result",
          requestId: parsed.requestId,
          deviceId: parsed.deviceId,
          accepted: result.accepted,
          message: result.message
        }));
        return;
      }
      if (parsed.type === "device.command" && parsed.command === "open_app") {
        const result = launchAppByName(String(parsed.appName ?? ""));
        socket.send(JSON.stringify({
          type: "device.command.result",
          requestId: parsed.requestId,
          deviceId: parsed.deviceId,
          accepted: result.accepted,
          message: result.message
        }));
        return;
      }
      if (parsed.type === "connected") {
        onStatus?.("open");
        return;
      }
      onEvent(parsed as unknown as FroshEvent);
    } catch {
      // Ignore malformed events from the server.
    }
  };
  socket.onerror = () => onStatus?.("closed");
  socket.onclose = () => onStatus?.("closed");

  return () => socket.close();
}
