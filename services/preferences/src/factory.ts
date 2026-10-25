import postgres from "postgres";
import type { FroshUserPreferenceStore } from "../../../packages/types/src/preferences";
import { InMemoryUserPreferenceStore, PostgresUserPreferenceStore } from "./store";

let store: FroshUserPreferenceStore | undefined;

export function getUserPreferenceStore(): FroshUserPreferenceStore {
  if (store) return store;
  const url = process.env.DATABASE_URL?.trim();
  store = url ? new PostgresUserPreferenceStore(postgres(url, { max: 5, idle_timeout: 20 })) : new InMemoryUserPreferenceStore();
  return store;
}

export async function closeUserPreferenceStore(): Promise<void> {
  const current = store;
  store = undefined;
  if (current instanceof PostgresUserPreferenceStore) await current.close();
}
