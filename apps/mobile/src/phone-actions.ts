import { Linking, Platform } from "react-native";
import type { FroshPhoneActionRequest, FroshPhoneActionResult } from "../../../packages/types/src/phone-actions";

export async function executePhoneAction(
  request: FroshPhoneActionRequest,
): Promise<FroshPhoneActionResult> {
  if (Platform.OS !== "android") {
    return { action: request.action, accepted: false, message: "This native action is only available on Android." };
  }

  if (request.action === "open_dialer") {
    await Linking.openURL("tel:");
    return { action: request.action, accepted: true, message: "Opened the phone dialer." };
  }

  if (request.action === "call_number") {
    if (!request.value) {
      return { action: request.action, accepted: false, message: "A phone number is required." };
    }
    await Linking.openURL(`tel:${request.value}`);
    return { action: request.action, accepted: true, message: "Opened the dialer with the requested number." };
  }

  if (request.action === "compose_message") {
    if (!request.value) {
      return { action: request.action, accepted: false, message: "A phone number is required." };
    }
    await Linking.openURL(`sms:${request.value}`);
    return { action: request.action, accepted: true, message: "Opened the messaging composer." };
  }

  if (request.action === "open_app") {
    if (!request.packageName) {
      return { action: request.action, accepted: false, message: "An Android package name is required." };
    }
    return {
      action: request.action,
      accepted: false,
      message: "Direct package launching requires the native Android app registry bridge and is not enabled by the JavaScript-only client yet.",
    };
  }

  return { action: request.action, accepted: false, message: "Unsupported phone action." };
}
