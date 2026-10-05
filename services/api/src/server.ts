import { FroshOrchestrator } from "../../ai/src";
import { OpenAIProvider } from "../../ai/src/openai-provider";
import { buildConversationContext, createMemoryStore } from "../../memory/src";

const provider = new OpenAIProvider();
const orchestrator = new FroshOrchestrator(provider);
const memory = createMemoryStore();

export interface FroshHttpRequest {
  message: string;
  conversationId?: string;
  userId?: string;
}

export async function handleFroshRequest(input: FroshHttpRequest) {
  const message = input.message?.trim();

  if (!message) throw new Error("message is required");

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

  return { conversationId: currentConversation.id, ...response };
}

export const handleJavisRequest = handleFroshRequest;
