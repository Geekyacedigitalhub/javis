import { requireNativeModule } from "expo-modules-core";
import type { FroshNotification, FroshNotificationCapability } from "../../../../packages/types/src/notifications";

type NativeNotifications = {
  getPermissionStatus(): string;
  openSettings(): boolean;
  getRecent(): Promise<FroshNotification[]>;
  reply(notificationId: string, message: string): Promise<{ accepted: boolean; message: string }>;
};

const native = requireNativeModule<NativeNotifications>("FroshNotifications");

export function getNotificationCapability(): FroshNotificationCapability {
  const status = native.getPermissionStatus();
  return {
    available: status === "available",
    message: status === "available" ? "Notification access is active." : "Notification access permission is required.",
  };
}

export function openNotificationSettings() {
  return native.openSettings();
}

export function getRecentNotifications() {
  return native.getRecent();
}

export function replyToNotification(notificationId: string, message: string) {
  return native.reply(notificationId, message);
}
