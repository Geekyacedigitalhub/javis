import type { FroshMemoryCandidate } from "../../../packages/types/src/conversation-memory";
import type { FroshUnifiedMessage } from "../../../packages/types/src/notifications";

const durableTerms = ["prefer", "usually", "always", "never", "remember", "project", "working on", "deadline", "meeting"];

export function extractMessageMemoryCandidates(messages: FroshUnifiedMessage[]): FroshMemoryCandidate[] {
  return messages
    .filter((message) => {
      const text = (message.text ?? "").toLowerCase();
      return text.length > 10 && durableTerms.some((term) => text.includes(term));
    })
    .slice(0, 20)
    .map((message) => ({
      kind: message.text?.toLowerCase().includes("prefer") ? "preference" : "important_fact",
      statement: message.text!.slice(0, 500),
      confidence: 0.6,
      sourceConversationId: `${message.provider}:${message.sender ?? "unknown"}`,
      sourceMessageId: message.id
    }));
}
