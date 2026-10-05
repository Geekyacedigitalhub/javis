import { Linking, Platform } from "react-native";
import type { FroshPhoneActionRequest, FroshPhoneActionResult } from "../../../packages/types/src/phone-actions";
import { launchApp } from "../modules/frosh-apps/src";
import { openCallDialer, placeDirectCall } from "../modules/frosh-calls/src";
import { searchContacts } from "../modules/frosh-contacts/src";
import { sendSms } from "../modules/frosh-messaging/src";

export async function executePhoneAction(
  request: FroshPhoneActionRequest,
): Promise<FroshPhoneActionResult> {
  if (Platform.OS !== "android") {
    return { action: request.action, accepted: false, message: "This native action is only available on Android." };
  }

  if (request.action === "open_dialer") {
    const result = openCallDialer();
    return { action: request.action, accepted: result.accepted, message: result.message };
  }

  if (request.action === "call_number") {
    if (!request.value) {
      return { action: request.action, accepted: false, message: "A phone number is required." };
    }
    const matches = searchContacts(request.value);
    const number = matches.length === 1 && matches[0].phones.length === 1 ? matches[0].phones[0].number : request.value;
    const result = placeDirectCall(number);
    return { action: request.action, accepted: result.accepted, message: result.message };
  }

  if (request.action === "send_message") {
    if (!request.value || !request.message) return { action: request.action, accepted: false, message: "A phone number and message are required." };
    const matches = searchContacts(request.value);
    const number = matches.length === 1 && matches[0].phones.length === 1 ? matches[0].phones[0].number : request.value;
    const result = sendSms(number, request.message);
    return { action: request.action, accepted: result.accepted, message: result.message };
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
    const result = launchApp(request.packageName);
    return {
      action: request.action,
      accepted: result.accepted,
      message: result.message,
    };
  }

  return { action: request.action, accepted: false, message: "Unsupported phone action." };
}
