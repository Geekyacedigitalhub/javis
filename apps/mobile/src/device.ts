import { Platform } from "react-native";

export function getAndroidDeviceInfo() {
  return {
    platform: Platform.OS,
    version: String(Platform.Version),
    model: "Android device",
    capabilities: [
      "device.info",
      "calls.dialer",
      "messages.compose",
    ],
  };
}
