import type { FroshCapabilityStatus } from "../../../packages/types/src/capabilities";

const capabilityDescriptions: FroshCapabilityStatus[] = [
  { capability: "device.info", availability: "available", detail: "Basic Android device information." },
  { capability: "apps.launch", availability: "permission_required", detail: "Requires Android package/app access." },
  { capability: "media.control", availability: "permission_required", detail: "Requires Android media-session access." },
  { capability: "calls.dialer", availability: "available", detail: "Can open the system dialer." },
  { capability: "calls.direct", availability: "permission_required", detail: "Direct calling requires user-granted phone permission." },
  { capability: "messages.compose", availability: "available", detail: "Can open supported system messaging flows." },
  { capability: "notifications.read", availability: "permission_required", detail: "Requires notification-listener access." },
  { capability: "camera.capture", availability: "permission_required", detail: "Requires camera permission." },
  { capability: "screen.observe", availability: "permission_required", detail: "Requires an approved Android screen/accessibility capability." },
  { capability: "location.read", availability: "permission_required", detail: "Requires location permission." }
];

export function getAndroidCapabilityStatus() {
  return capabilityDescriptions;
}
