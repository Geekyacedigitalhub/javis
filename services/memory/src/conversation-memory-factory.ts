import { getFroshDatabaseClient } from "../../database/src";
import { InMemoryConversationMemoryStore } from "./conversation-memory";
import { PostgresConversationMemoryStore } from "./postgres-conversation-memory";
import type { FroshConversationMemoryStore } from "../../../packages/types/src/conversation-memory";

let store: FroshConversationMemoryStore | undefined;

export function getConversationMemoryStore(): FroshConversationMemoryStore {
  if (store) return store;

  const database = getFroshDatabaseClient();
  store = database
    ? new PostgresConversationMemoryStore(database)
    : new InMemoryConversationMemoryStore();

  return store;
}
