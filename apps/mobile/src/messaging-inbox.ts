import type { FroshNotification, FroshUnifiedInbox, FroshUnifiedMessage } from "../../../packages/types/src/notifications";
import { getRecentNotifications, replyToNotification } from "../modules/frosh-notifications/src";

const providerByPackage: Record<string, string> = {
  "com.whatsapp": "whatsapp",
  "org.telegram.messenger": "telegram",
  "com.facebook.orca": "messenger",
  "com.instagram.android": "instagram",
  "com.discord": "discord",
  "com.google.android.apps.messaging": "sms"
};

export function getUnifiedMessagingInbox(): Promise<FroshUnifiedInbox> {
  return getRecentNotifications().then((notifications: FroshNotification[]) => ({
    messages: notifications
      .filter((item) => Boolean(providerByPackage[item.packageName]))
      .map((item): FroshUnifiedMessage => ({
        id: item.id,
        provider: providerByPackage[item.packageName],
        packageName: item.packageName,
        appName: item.appName,
        sender: item.title,
        text: item.text,
        receivedAt: item.receivedAt,
        canReply: Boolean(item.canReply),
        notificationId: item.id
      }))
  }));
}

export function replyToUnifiedMessage(notificationId: string, message: string) {
  return replyToNotification(notificationId, message);
}
