import type { FroshEvent } from "../../../packages/types/src/events";
import { FROSH_API_URL } from "./api";

function websocketUrl() {
  return FROSH_API_URL.replace(/^http/, "ws") + "/v1/realtime";
}

export function connectFroshRealtime(
  onEvent: (event: FroshEvent) => void,
  onStatus?: (status: "connecting" | "open" | "closed") => void,
) {
  onStatus?.("connecting");
  const socket = new WebSocket(websocketUrl());

  socket.onopen = () => onStatus?.("open");
  socket.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as FroshEvent);
    } catch {
      // Ignore malformed events from the server.
    }
  };
  socket.onerror = () => onStatus?.("closed");
  socket.onclose = () => onStatus?.("closed");

  return () => socket.close();
}
