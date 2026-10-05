import type { FroshConversation, FroshConversationInbox, FroshUnifiedMessage } from "../../../packages/types/src/notifications";
import { getUnifiedMessagingInbox } from "./messaging-inbox";

function conversationKey(message: FroshUnifiedMessage) {
  return [message.provider, message.packageName, (message.sender ?? "unknown").trim().toLowerCase()].join(":");
}

export async function getMessageConversations(): Promise<FroshConversationInbox> {
  const { messages } = await getUnifiedMessagingInbox();
  const groups = new Map<string, FroshUnifiedMessage[]>();

  for (const message of messages) {
    const key = conversationKey(message);
    const current = groups.get(key) ?? [];
    current.push(message);
    groups.set(key, current);
  }

  const conversations: FroshConversation[] = [...groups.entries()].map(([id, items]) => {
    const ordered = [...items].sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
    const latestMessage = ordered[0];
    return {
      id,
      provider: latestMessage.provider,
      packageName: latestMessage.packageName,
      appName: latestMessage.appName,
      participant: latestMessage.sender ?? "Unknown",
      messages: ordered,
      latestMessage,
      unreadCount: ordered.length,
      canReply: ordered.some((item) => item.canReply)
    };
  });

  conversations.sort((a, b) => {
    const aTime = a.latestMessage ? Date.parse(a.latestMessage.receivedAt) : 0;
    const bTime = b.latestMessage ? Date.parse(b.latestMessage.receivedAt) : 0;
    return bTime - aTime;
  });

  return { conversations };
}
