import type { FroshMediaRequest, FroshMediaResult, FroshMediaState } from "../../../packages/types/src/media";
import { executeMediaAction, getMediaState } from "./media";

export function controlMedia(request: FroshMediaRequest): Promise<FroshMediaResult> {
  return executeMediaAction(request);
}

export function readMediaState(): Promise<FroshMediaState> {
  return getMediaState();
}
