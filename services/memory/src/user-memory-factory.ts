import { getFroshDatabaseClient } from "../../database/src";
import { InMemoryUserMemoryStore, PostgresUserMemoryStore } from "./user-memory";
import type { FroshUserMemoryStore } from "../../../packages/types/src/conversation-memory";

let store: FroshUserMemoryStore | undefined;

export function getUserMemoryStore(): FroshUserMemoryStore {
  if (store) return store;
  const database = getFroshDatabaseClient();
  store = database
    ? new PostgresUserMemoryStore(database)
    : new InMemoryUserMemoryStore();
  return store;
}
