import { FroshOrchestrator } from "../../ai/src";
import { OpenAIProvider } from "../../ai/src/openai-provider";
import { buildConversationContext, createMemoryStore, getConversationMemoryStore, getUserMemoryStore, extractConversationMemories, createMemoryCandidate } from "../../memory/src";

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

  if (conversation?.userId && input.userId && conversation.userId !== input.userId) {
    throw new Error("Conversation belongs to another user");
  }

  if (conversation?.userId && !input.userId) {
    throw new Error("Conversation owner is required");
  }

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

  if (input.userId) {
    const userMemories = await getUserMemoryStore().list(input.userId, 30);
    if (userMemories.length) {
      context.unshift({
        role: "system",
        content: [
          "Approved long-term user memory:",
          ...userMemories.map((memory) => "- [" + memory.kind + "] " + memory.statement),
          "Use these memories only when relevant to the current request."
        ].join("\n")
      });
    }
  }

  const conversationMemory = await getConversationMemoryStore().get(currentConversation.id);
  if (conversationMemory && (conversationMemory.summary || conversationMemory.keyFacts.length)) {
    const remembered = [
      "Approved long-term context for this conversation:",
      ...conversationMemory.keyFacts.map((fact) => "- " + fact),
    ];
    context.unshift({ role: "system", content: remembered.join("\n") });
  }

  const response = await orchestrator.respond(context);

  await memory.appendMessage({
    conversationId: currentConversation.id,
    role: "assistant",
    content: response.message,
  });

  if (input.userId) {
    const extraction = extractConversationMemories([{
      id: crypto.randomUUID(),
      text: message,
      conversationId: currentConversation.id,
    }]);

    for (const candidate of extraction.candidates) {
      await createMemoryCandidate({
        ...candidate,
        userId: input.userId,
      });
    }
  }

  return { conversationId: currentConversation.id, ...response };
}

export const handleJavisRequest = handleFroshRequest;
