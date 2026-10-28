import { createProvider, describeProvider } from "./provider-factory";

/**
 * Generate message drafts through the same configured assistant provider as
 * chat. Keeping this behind the provider boundary prevents the Messages screen
 * from silently requiring a different paid model than the rest of FROSH.
 */
export async function suggestMessageReplies(input: { provider: string; sender?: string; message: string }) {
  const status = describeProvider();
  if (!status.configured) throw new Error(status.message);

  const prompt = [
    "Suggest exactly 3 short replies to this incoming message.",
    "Return one reply per line, with no numbering, bullets, quotes, or explanation.",
    "Keep the replies natural and human. Vary the tone: friendly, direct, and professional.",
    "Never invent facts, promises, dates, or commitments.",
    "Provider: " + input.provider,
    "Sender: " + (input.sender ?? "Unknown"),
    "Incoming message: " + input.message,
  ].join("\n");

  const response = await createProvider().generate({
    system: "You are FROSH's message reply assistant. Generate safe, concise reply drafts. Do not call tools.",
    messages: [{ role: "user", content: prompt }],
    tools: [],
  });

  const replies = response.message
    .split("\n")
    .map((line) => line.trim().replace(/^[-*•]\s*/, "").replace(/^\d+[.)]\s*/, ""))
    .filter(Boolean)
    .slice(0, 3);
  if (!replies.length) throw new Error("The AI provider returned no usable reply drafts.");
  return replies;
}
