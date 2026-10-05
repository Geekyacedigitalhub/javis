export type FroshDevicePlatform = "android" | "windows" | "web";
export type FroshDeviceStatus = "online" | "offline" | "unknown";

export interface FroshDevice {
  id: string;
  name: string;
  platform: FroshDevicePlatform;
  status: FroshDeviceStatus;
  capabilities: string[];
  lastSeenAt?: string;
}

export interface FroshDeviceRegistration {
  name: string;
  platform: FroshDevicePlatform;
  capabilities: string[];
}

export interface FroshDeviceCredential {
  deviceId: string;
  token: string;
  expiresAt: string;
}
