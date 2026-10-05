import type { FroshMemoryCandidate, FroshMemoryExtractionResult } from "../../../packages/types/src/conversation-memory";

const durableSignals = [
  { kind: "preference" as const, terms: ["prefer", "likes", "love", "hate", "don't like", "usually use"] },
  { kind: "commitment" as const, terms: ["i will", "i'll", "we will", "we'll", "remind me", "meeting"] },
  { kind: "project_context" as const, terms: ["project", "app", "website", "working on", "building"] },
  { kind: "important_fact" as const, terms: ["important", "remember", "my goal", "deadline"] }
];

const sensitiveSignals = [
  "password", "passcode", "pin", "otp", "one-time code", "credit card", "bank account",
  "private key", "secret key", "api key", "security question"
];

export function extractConversationMemories(
  messages: Array<{ id: string; text?: string; conversationId?: string }>
): FroshMemoryExtractionResult {
  const candidates: FroshMemoryCandidate[] = [];
  let skippedCount = 0;

  for (const message of messages) {
    const text = (message.text ?? "").trim();
    const lower = text.toLowerCase();

    if (!text || sensitiveSignals.some((term) => lower.includes(term))) {
      skippedCount++;
      continue;
    }

    const match = durableSignals.find((signal) => signal.terms.some((term) => lower.includes(term)));
    if (!match) {
      skippedCount++;
      continue;
    }

    candidates.push({
      kind: match.kind,
      statement: text.length > 500 ? text.slice(0, 500) : text,
      confidence: 0.65,
      sourceConversationId: message.conversationId,
      sourceMessageId: message.id
    });
  }

  return { candidates: candidates.slice(0, 20), skippedCount };
}
