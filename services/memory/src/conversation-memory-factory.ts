import { InMemoryConversationMemoryStore } from "./conversation-memory";

const store = new InMemoryConversationMemoryStore();

export function getConversationMemoryStore() {
  return store;
}
