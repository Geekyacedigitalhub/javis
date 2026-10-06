import * as SecureStore from "expo-secure-store";
import type { FroshDeviceCredential } from "../../../packages/types/src/device";

const CREDENTIAL_KEY = "frosh.device.credential";
const MAX_DEVICE_ID_LENGTH = 200;
const MAX_DEVICE_TOKEN_LENGTH = 512;

function validCredential(value: unknown): value is FroshDeviceCredential {
  if (!value || typeof value !== "object") return false;
  const credential = value as Partial<FroshDeviceCredential>;
  if (
    typeof credential.deviceId !== "string" ||
    credential.deviceId.length === 0 ||
    credential.deviceId.length > MAX_DEVICE_ID_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(credential.deviceId) ||
    typeof credential.token !== "string" ||
    credential.token.length === 0 ||
    credential.token.length > MAX_DEVICE_TOKEN_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(credential.token) ||
    typeof credential.expiresAt !== "string"
  ) return false;

  const expiresAt = Date.parse(credential.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

export async function loadDeviceCredential() {
  let raw: string | null;
  try {
    raw = await SecureStore.getItemAsync(CREDENTIAL_KEY);
  } catch {
    // SecureStore availability is an authentication prerequisite. Never fall
    // back to an in-memory or otherwise unprotected credential.
    return null;
  }
  if (!raw) return null;

  try {
    const value: unknown = JSON.parse(raw);
    if (!validCredential(value)) {
      await SecureStore.deleteItemAsync(CREDENTIAL_KEY).catch(() => undefined);
      return null;
    }
    return value;
  } catch {
    // Corrupt credential state must fail closed. Best-effort cleanup is safe,
    // but cleanup failure must not turn corruption into an authentication path.
    await SecureStore.deleteItemAsync(CREDENTIAL_KEY).catch(() => undefined);
    return null;
  }
}

export async function saveDeviceCredential(value: FroshDeviceCredential) {
  if (!validCredential(value)) {
    throw new Error("Invalid or expired device credential");
  }
  await SecureStore.setItemAsync(CREDENTIAL_KEY, JSON.stringify(value));
}

export async function clearDeviceCredential() {
  await SecureStore.deleteItemAsync(CREDENTIAL_KEY);
}
