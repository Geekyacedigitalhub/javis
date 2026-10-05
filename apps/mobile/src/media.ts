import { Platform } from "react-native";
import type { FroshMediaRequest, FroshMediaResult, FroshMediaState } from "../../../packages/types/src/media";

export async function getMediaState(): Promise<FroshMediaState> {
  if (Platform.OS !== "android") {
    return { available: false, message: "Media control is currently Android-only." };
  }

  return {
    available: false,
    message: "Android media-session integration requires the native MediaSession bridge and user-approved media access.",
  };
}

export async function executeMediaAction(
  request: FroshMediaRequest,
): Promise<FroshMediaResult> {
  if (Platform.OS !== "android") {
    return { action: request.action, accepted: false, message: "Media control is currently Android-only." };
  }

  return {
    action: request.action,
    accepted: false,
    message: "Media action is waiting for the Android MediaSession bridge.",
  };
}
