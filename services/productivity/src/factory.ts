import type { FroshTaskStore } from "../../../packages/types/src/productivity";
import { getFroshDatabaseClient } from "../../database/src";
import { InMemoryTaskStore, PostgresTaskStore } from "./store";

let store: FroshTaskStore | undefined;

export function getTaskStore(): FroshTaskStore {
  if (store) return store;
  const database = getFroshDatabaseClient();
  store = database ? new PostgresTaskStore(database) : new InMemoryTaskStore();
  return store;
}

export async function closeTaskStore(): Promise<void> {
  store = undefined;
}
