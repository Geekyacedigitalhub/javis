import { JavisOrchestrator } from "../../ai/src";
import { DevelopmentProvider } from "../../ai/src/mock-provider";
import {
  InMemoryStore,
  buildConversationContext,
} from "../../memory/src";

const provider = new DevelopmentProvider();
const orchestrator = new JavisOrchestrator(provider);
const memory = createMemoryStore();

export interface JavisHttpRequest {
  message: string;
  conversationId?: string;
  userId?: string;
}

export async function handleJavisRequest(input: JavisHttpRequest) {
  const message = input.message?.trim();

  if (!message) {
    throw new Error("message is required");
  }

  const conversation = input.conversationId
    ? await memory.getConversation(input.conversationId)
    : null;

  const currentConversation =
    conversation ??
    (await memory.createConversation({
      id: input.conversationId,
      userId: input.userId,
    }));

  await memory.appendMessage({
    conversationId: currentConversation.id,
    role: "user",
    content: message,
  });

  const context = await buildConversationContext(
    memory,
    currentConversation.id,
    input.userId,
  );

  const response = await orchestrator.respond(context);

  await memory.appendMessage({
    conversationId: currentConversation.id,
    role: "assistant",
    content: response.message,
  });

  return {
    conversationId: currentConversation.id,
    ...response,
  };
}
