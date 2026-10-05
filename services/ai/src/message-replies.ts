import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model = process.env.FROSH_MODEL || "gpt-6-luna";

export async function suggestMessageReplies(input: { provider: string; sender?: string; message: string }) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const prompt = [
    "Suggest exactly 3 short replies to this incoming message.",
    "Return one reply per line, with no numbering, bullets, quotes, or explanation.",
    "Keep the replies natural and human. Vary the tone: friendly, direct, and professional.",
    "Never invent facts, promises, dates, or commitments.",
    "Provider: " + input.provider,
    "Sender: " + (input.sender ?? "Unknown"),
    "Incoming message: " + input.message
  ].join("\n");
  const response = await client.responses.create({
    model,
    instructions: "You are FROSH message reply assistant. Generate safe, concise reply drafts.",
    input: prompt,
    store: false
  });
  return response.output_text.split("\n").map((line) => line.trim().replace(/^[-*•]\\s*/, "").replace(/^\\d+[.)]\\s*/, "")).filter(Boolean).slice(0, 3);
}
