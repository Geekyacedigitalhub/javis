import { JavisOrchestrator } from "../../ai/src";

const orchestrator = new JavisOrchestrator({
  async generate({ messages }) {
    const last = messages.at(-1)?.content ?? "";
    return {
      message: `JARVIS core received: ${last}`,
      toolCalls: [],
    };
  },
});

export async function handleJavisRequest(input: {
  message: string;
  conversationId?: string;
}) {
  const response = await orchestrator.respond([
    {
      role: "user",
      content: input.message,
    },
  ]);

  return {
    conversationId: input.conversationId ?? crypto.randomUUID(),
    ...response,
  };
}
