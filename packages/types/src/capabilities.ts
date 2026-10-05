export type FroshCapability =
  | "device.info"
  | "apps.launch"
  | "media.control"
  | "calls.dialer"
  | "calls.direct"
  | "messages.compose"
  | "notifications.read"
  | "camera.capture"
  | "screen.observe"
  | "location.read";

export type FroshCapabilityAvailability = "available" | "permission_required" | "unsupported";

export interface FroshCapabilityStatus {
  capability: FroshCapability;
  availability: FroshCapabilityAvailability;
  detail?: string;
}
