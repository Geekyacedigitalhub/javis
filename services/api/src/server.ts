import { JavisOrchestrator } from "../../ai/src";
import { DevelopmentProvider } from "../../ai/src/mock-provider";

const provider = new DevelopmentProvider();
const orchestrator = new JavisOrchestrator(provider);

export interface JavisHttpRequest {
  message: string;
  conversationId?: string;
}

export async function handleJavisRequest(input: JavisHttpRequest) {
  if (!input.message?.trim()) {
    throw new Error("message is required");
  }

  const response = await orchestrator.respond([
    {
      role: "user",
      content: input.message.trim(),
    },
  ]);

  return {
    conversationId: input.conversationId ?? crypto.randomUUID(),
    ...response,
  };
}
