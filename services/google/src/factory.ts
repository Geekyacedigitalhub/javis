import postgres from "postgres";
import type { FroshGoogleIntegrationStore } from "../../../packages/types/src/google";
import { InMemoryGoogleIntegrationStore, PostgresGoogleIntegrationStore } from "./store";

let store: FroshGoogleIntegrationStore | undefined;

export function getGoogleIntegrationStore(): FroshGoogleIntegrationStore {
  if (store) return store;
  const databaseUrl = process.env.DATABASE_URL?.trim();
  store = databaseUrl
    ? new PostgresGoogleIntegrationStore(postgres(databaseUrl, {
      max: 2,
      idle_timeout: 20,
      // Do not let an unavailable database connection leave a web request open
      // until an upstream proxy turns it into an opaque 502 page.
      connect_timeout: 10,
    }))
    : new InMemoryGoogleIntegrationStore();
  return store;
}

export async function closeGoogleIntegrationStore(): Promise<void> {
  const current = store;
  store = undefined;
  if (current instanceof PostgresGoogleIntegrationStore) await current.close();
}
