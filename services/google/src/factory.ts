import postgres from "postgres";
import type { FroshGoogleIntegrationStore } from "../../../packages/types/src/google";
import { InMemoryGoogleIntegrationStore, PostgresGoogleIntegrationStore } from "./store";

let store: FroshGoogleIntegrationStore | undefined;

export function getGoogleIntegrationStore(): FroshGoogleIntegrationStore {
  if (store) return store;
  const databaseUrl = process.env.DATABASE_URL?.trim();
  store = databaseUrl
    ? new PostgresGoogleIntegrationStore(postgres(databaseUrl, { max: 5, idle_timeout: 20 }))
    : new InMemoryGoogleIntegrationStore();
  return store;
}

export async function closeGoogleIntegrationStore(): Promise<void> {
  const current = store;
  store = undefined;
  if (current instanceof PostgresGoogleIntegrationStore) await current.close();
}
