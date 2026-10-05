import type { FroshNotification, FroshUnifiedInbox, FroshUnifiedMessage } from "../../../packages/types/src/notifications";
import { getRecentNotifications, replyToNotification } from "../modules/frosh-notifications/src";
import { extractConversationMemories } from "../../../services/memory/src/memory-extractor";
import { getConversationMemoryStore } from "../../../services/memory/src/conversation-memory-factory";

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

export function extractInboxMemoryCandidates(inbox: FroshUnifiedInbox) {
  return extractConversationMemories(inbox.messages.map((item) => ({ id: item.id, text: item.text, conversationId: [item.provider, item.packageName, item.sender ?? "unknown"].join(":") })));
}

export function replyToUnifiedMessage(notificationId: string, message: string) {
  return replyToNotification(notificationId, message);
}

export async function saveInboxMemoryCandidates(inbox: FroshUnifiedInbox) {
  const extraction = extractInboxMemoryCandidates(inbox);
  const store = getConversationMemoryStore();
  for (const candidate of extraction.candidates) {
    const id = candidate.sourceConversationId ?? crypto.randomUUID();
    const existing = await store.get(id);
    const facts = existing?.keyFacts ?? [];
    if (!facts.includes(candidate.statement)) {
      await store.upsert({
        id,
        provider: existing?.provider ?? "other",
        participant: existing?.participant ?? "Unknown",
        summary: existing?.summary ?? "Communication context captured by FROSH.",
        keyFacts: [...facts, candidate.statement].slice(-20),
        lastMessageAt: new Date().toISOString()
      });
    }
  }
  return extraction;
}
