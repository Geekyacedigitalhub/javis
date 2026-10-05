import type { JavisMessage } from "../../../packages/types/src/javis";
import type { MemoryStore } from "./types";

export async function buildConversationContext(
  store: MemoryStore,
  conversationId: string,
  userId?: string,
): Promise<JavisMessage[]> {
  const messages = await store.listMessages(conversationId, 50);
  const context: JavisMessage[] = messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  if (userId) {
    const memories = await store.listMemories(userId, 20);

    if (memories.length) {
      const remembered = ["Relevant remembered context:"];
      for (const memory of memories) {
        remembered.push("- [" + memory.kind + "] " + memory.content);
      }
      context.unshift({ role: "system", content: remembered.join("\n") });
    }
  }

  return context;
}
