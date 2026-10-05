import postgres from "postgres";
import { InMemoryConversationMemoryStore } from "./conversation-memory";
import { PostgresConversationMemoryStore } from "./postgres-conversation-memory";
import type { FroshConversationMemoryStore } from "../../../packages/types/src/conversation-memory";

let store: FroshConversationMemoryStore | undefined;

export function getConversationMemoryStore(): FroshConversationMemoryStore {
  if (store) return store;

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) {
    store = new PostgresConversationMemoryStore(postgres(databaseUrl, {
      max: 5,
      idle_timeout: 20
    }));
  } else {
    store = new InMemoryConversationMemoryStore();
  }

  return store;
}
