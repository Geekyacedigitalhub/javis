import type { FroshDevice, FroshDeviceRegistration } from "../../../packages/types/src/device";

const devices = new Map<string, FroshDevice>();

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
