export type FroshCapability =
  | "device.info"
  | "apps.launch"
  | "media.control"
  | "calls.dialer"
  | "calls.direct"
  | "messages.compose"
  | "messages.send"
  | "contacts.read"
  | "notifications.reply"
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


export const FROSH_CAPABILITIES: readonly FroshCapability[] = [
  "device.info", "apps.launch", "media.control", "calls.dialer", "calls.direct",
  "messages.compose", "messages.send", "contacts.read", "notifications.reply",
  "notifications.read", "camera.capture", "screen.observe", "location.read",
];

export function isFroshCapability(value: string): value is FroshCapability {
  return (FROSH_CAPABILITIES as readonly string[]).includes(value);
}
