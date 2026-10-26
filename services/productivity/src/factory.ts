import postgres from "postgres";
import type { FroshTaskStore } from "../../../packages/types/src/productivity";
import { InMemoryTaskStore, PostgresTaskStore } from "./store";

let store: FroshTaskStore | undefined;

export function getTaskStore(): FroshTaskStore {
  if (store) return store;
  const url = process.env.DATABASE_URL?.trim();
  store = url ? new PostgresTaskStore(postgres(url, { max: 5, idle_timeout: 20 })) : new InMemoryTaskStore();
  return store;
}

export async function closeTaskStore(): Promise<void> {
  const current = store;
  store = undefined;
  if (current instanceof PostgresTaskStore) await current.close();
}
