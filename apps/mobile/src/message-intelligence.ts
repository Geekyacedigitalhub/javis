import type {
  FroshMessageInsight,
  FroshMessagePriority,
  FroshMessagingSummary,
  FroshUnifiedMessage
} from "../../../packages/types/src/notifications";
import { getUnifiedMessagingInbox } from "./messaging-inbox";

const urgentTerms = ["urgent", "asap", "emergency", "immediately", "911", "help"];
const replySignals = ["?", "can you", "could you", "please", "let me know", "are you", "will you", "when", "where"];

function classify(message: FroshUnifiedMessage): FroshMessageInsight {
  const text = (message.text ?? "").trim();
  const lower = text.toLowerCase();
  const urgent = urgentTerms.some((term) => lower.includes(term));
  const question = replySignals.some((term) => lower.includes(term));
  const priority: FroshMessagePriority = urgent ? "urgent" : question ? "high" : message.canReply ? "normal" : "low";
  return {
    ...message,
    priority,
    likelyNeedsReply: Boolean(message.canReply && (question || text.length > 0)),
    reason: urgent ? "Contains an urgency signal." : question ? "Looks like a question or request." : undefined
  };
}

export async function getMessageIntelligence(): Promise<FroshMessagingSummary> {
  const { messages } = await getUnifiedMessagingInbox();
  const insights = messages.map(classify);
  const byProvider: Record<string, number> = {};
  for (const item of insights) byProvider[item.provider] = (byProvider[item.provider] ?? 0) + 1;
  return {
    total: insights.length,
    needsReply: insights.filter((item) => item.likelyNeedsReply).length,
    urgent: insights.filter((item) => item.priority === "urgent").length,
    byProvider,
    highlights: insights
      .sort((a, b) => {
        const rank: Record<FroshMessagePriority, number> = { urgent: 4, high: 3, normal: 2, low: 1 };
        return rank[b.priority] - rank[a.priority];
      })
      .slice(0, 20)
  };
}
