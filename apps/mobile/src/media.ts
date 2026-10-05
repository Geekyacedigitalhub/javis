import { Platform } from "react-native";
import type { FroshMediaRequest, FroshMediaResult, FroshMediaState } from "../../../packages/types/src/media";

type NativeMediaModule = {
  getPermissionStatus(): string;
  getState(): Promise<Record<string, unknown>>;
  control(action: string): Promise<{ accepted: boolean; message: string }>;
  volume(direction: "up" | "down"): Promise<{ accepted: boolean; message: string }>;
};

let nativeMedia: NativeMediaModule | null = null;

function loadNativeMedia() {
  if (Platform.OS !== "android") return null;
  if (nativeMedia) return nativeMedia;
  try {
    const module = require("../modules/frosh-media/src").default as NativeMediaModule;
    nativeMedia = module;
    return module;
  } catch {
    return null;
  }
}

export async function getMediaState(): Promise<FroshMediaState> {
  if (Platform.OS !== "android") {
    return { available: false, message: "Media control is currently Android-only." };
  }

  const native = loadNativeMedia();
  if (!native) {
    return { available: false, message: "FROSH media native module is not installed in this build." };
  }

  if (native.getPermissionStatus() !== "available") {
    return { available: false, message: "Android media-session access is not available. Enable FROSH media/notification access in Android settings." };
  }

  const state = await native.getState();
  return {
    available: Boolean(state.available),
    isPlaying: Boolean(state.isPlaying),
    title: typeof state.title === "string" ? state.title : undefined,
    artist: typeof state.artist === "string" ? state.artist : undefined,
    album: typeof state.album === "string" ? state.album : undefined,
    durationMs: typeof state.durationMs === "number" ? state.durationMs : undefined,
    positionMs: typeof state.positionMs === "number" ? state.positionMs : undefined,
    message: typeof state.message === "string" ? state.message : undefined,
  };
}

export async function executeMediaAction(
  request: FroshMediaRequest,
): Promise<FroshMediaResult> {
  if (Platform.OS !== "android") {
    return { action: request.action, accepted: false, message: "Media control is currently Android-only." };
  }

  const native = loadNativeMedia();
  if (!native) {
    return { action: request.action, accepted: false, message: "FROSH media native module is not installed in this build." };
  }

  if (request.action === "volume_up" || request.action === "volume_down") {
    const result = await native.volume(request.action === "volume_up" ? "up" : "down");
    return { action: request.action, ...result };
  }

  const result = await native.control(request.action);
  return { action: request.action, ...result };
}
