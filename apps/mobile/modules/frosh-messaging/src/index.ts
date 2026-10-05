import { requireNativeModule } from "expo-modules-core";

type NativeMessaging = {
  getPermissionStatus(): string;
  requestPermission(): Promise<boolean>;
  send(phoneNumber: string, message: string): { accepted: boolean; message: string };
};

const native = requireNativeModule<NativeMessaging>("FroshMessaging");
export const getMessagingPermissionStatus = () => native.getPermissionStatus();
export const requestMessagingPermission = () => native.requestPermission();
export const sendSms = (phoneNumber: string, message: string) => native.send(phoneNumber, message);
