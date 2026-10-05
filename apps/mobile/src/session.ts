import * as SecureStore from "expo-secure-store";
import type { FroshDeviceCredential } from "../../../packages/types/src/device";

const CREDENTIAL_KEY = "frosh.device.credential";

export async function loadDeviceCredential() {
  const raw = await SecureStore.getItemAsync(CREDENTIAL_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as FroshDeviceCredential;
    if (!value.deviceId || !value.token || new Date(value.expiresAt).getTime() <= Date.now()) {
      await clearDeviceCredential();
      return null;
    }
    return value;
  } catch {
    await clearDeviceCredential();
    return null;
  }
}

export async function saveDeviceCredential(value: FroshDeviceCredential) {
  await SecureStore.setItemAsync(CREDENTIAL_KEY, JSON.stringify(value));
}

export async function clearDeviceCredential() {
  await SecureStore.deleteItemAsync(CREDENTIAL_KEY);
}
