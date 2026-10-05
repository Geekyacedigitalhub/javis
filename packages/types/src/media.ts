export type FroshMediaAction =
  | "play"
  | "pause"
  | "toggle"
  | "next"
  | "previous"
  | "stop"
  | "volume_up"
  | "volume_down";

export interface FroshMediaRequest {
  action: FroshMediaAction;
}

export interface FroshMediaState {
  available: boolean;
  isPlaying?: boolean;
  title?: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  positionMs?: number;
  message?: string;
}

export interface FroshMediaResult {
  action: FroshMediaAction;
  accepted: boolean;
  message: string;
}
