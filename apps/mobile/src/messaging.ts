import type { FroshMessagingCapability, FroshMessagingProvider, FroshMessagingProviderInfo, FroshMessagingSupport } from "../../../packages/types/src/messaging";
import { listInstalledMessagingApps } from "../modules/frosh-apps/src";

const labels: Record<FroshMessagingProvider, string> = {
  sms: "SMS",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  messenger: "Messenger",
  instagram: "Instagram",
  discord: "Discord",
  other: "Other"
};

const supports: Record<FroshMessagingProvider, FroshMessagingSupport> = {
  sms: "direct_send",
  whatsapp: "notification_reply",
  telegram: "notification_reply",
  messenger: "notification_reply",
  instagram: "notification_reply",
  discord: "notification_reply",
  other: "unsupported"
};

export function getMessagingCapability(): FroshMessagingCapability {
  const installed = listInstalledMessagingApps();
  const byProvider = new Map(installed.map((item) => [item.provider as FroshMessagingProvider, item]));
  const providers: FroshMessagingProviderInfo[] = (Object.keys(labels) as FroshMessagingProvider[]).map((provider) => {
    const app = byProvider.get(provider);
    return {
      provider,
      displayName: labels[provider],
      installed: Boolean(app),
      support: app ? supports[provider] : "unsupported",
      detail: app ? `${app.name} is installed. Messaging support: ${supports[provider]}.` : `${labels[provider]} is not detected on this device.`
    };
  });
  return { providers };
}
