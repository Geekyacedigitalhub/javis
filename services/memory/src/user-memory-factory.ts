import postgres from "postgres";
import { InMemoryUserMemoryStore, PostgresUserMemoryStore } from "./user-memory";
import type { FroshUserMemoryStore } from "../../../packages/types/src/conversation-memory";

let store: FroshUserMemoryStore | undefined;

export function getUserMemoryStore(): FroshUserMemoryStore {
  if (store) return store;
  const url = process.env.DATABASE_URL?.trim();
  store = url
    ? new PostgresUserMemoryStore(postgres(url, { max: 5, idle_timeout: 20 }))
    : new InMemoryUserMemoryStore();
  return store;
}
