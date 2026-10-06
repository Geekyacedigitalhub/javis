import type { FroshDevice, FroshDeviceRegistration } from "../../../packages/types/src/device";
import type { FroshCapabilityStatus } from "../../../packages/types/src/capabilities";

const devices = new Map<string, FroshDevice>();
const credentials = new Map<string, { token: string; expiresAt: number }>();

export function registerDevice(input: FroshDeviceRegistration) {
  const now = new Date().toISOString();
  const existing = [...devices.values()].find(
    (device) => device.name === input.name && device.platform === input.platform,
  );

  const device: FroshDevice = {
    id: existing?.id ?? crypto.randomUUID(),
    name: input.name,
    platform: input.platform,
    status: "online",
    capabilities: [...new Set(input.capabilities)],
    lastSeenAt: now,
  };

  devices.set(device.id, device);
  return device;
}

export function listDevices() {
  return [...devices.values()];
}

export function getDevice(id: string) {
  return devices.get(id) ?? null;
}

export function markDeviceOffline(id: string) {
  const device = devices.get(id);
  if (!device) return null;
  const updated = { ...device, status: "offline" as const };
  devices.set(id, updated);
  return updated;
}

export function issueDeviceCredential(deviceId: string) {
  if (!devices.has(deviceId)) return null;
  const token = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const configuredTtl = Number(process.env.FROSH_DEVICE_CREDENTIAL_TTL_MS ?? 30 * 24 * 60 * 60 * 1000);
  const ttlMs = Number.isFinite(configuredTtl)
    ? Math.min(90 * 24 * 60 * 60 * 1000, Math.max(5 * 60 * 1000, Math.floor(configuredTtl)))
    : 30 * 24 * 60 * 60 * 1000;
  const expiresAt = Date.now() + ttlMs;
  credentials.set(deviceId, { token, expiresAt });
  return { deviceId, token, expiresAt: new Date(expiresAt).toISOString() };
}

export function revokeDeviceCredential(deviceId: string) {
  if (!devices.has(deviceId)) return false;
  return credentials.delete(deviceId);
}

export function authenticateDevice(deviceId: string, token: string) {
  const credential = credentials.get(deviceId);
  if (!credential || credential.expiresAt <= Date.now() || credential.token !== token) return false;
  const device = devices.get(deviceId);
  if (!device) return false;
  devices.set(deviceId, { ...device, status: "online", lastSeenAt: new Date().toISOString() });
  return true;
}

export function updateDeviceCapabilities(deviceId: string, capabilities: FroshCapabilityStatus[]) {
  const device = devices.get(deviceId);
  if (!device) return null;

  const updated = {
    ...device,
    capabilities: capabilities
      .filter((item) => item.availability === "available")
      .map((item) => item.capability),
    lastSeenAt: new Date().toISOString(),
    status: "online" as const,
  };

  devices.set(deviceId, updated);
  return updated;
}
