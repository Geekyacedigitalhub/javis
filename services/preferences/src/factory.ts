import type { FroshUserPreferenceStore } from "../../../packages/types/src/preferences";
import { getFroshDatabaseClient } from "../../database/src";
import { InMemoryUserPreferenceStore, PostgresUserPreferenceStore } from "./store";

let store: FroshUserPreferenceStore | undefined;

export function getUserPreferenceStore(): FroshUserPreferenceStore {
  if (store) return store;
  const database = getFroshDatabaseClient();
  store = database ? new PostgresUserPreferenceStore(database) : new InMemoryUserPreferenceStore();
  return store;
}

export async function closeUserPreferenceStore(): Promise<void> {
  store = undefined;
}
