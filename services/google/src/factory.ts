import type { FroshGoogleIntegrationStore } from "../../../packages/types/src/google";
import { getFroshDatabaseClient } from "../../database/src";
import { InMemoryGoogleIntegrationStore, PostgresGoogleIntegrationStore } from "./store";

let store: FroshGoogleIntegrationStore | undefined;

export function getGoogleIntegrationStore(): FroshGoogleIntegrationStore {
  if (store) return store;
  const database = getFroshDatabaseClient();
  store = database
    ? new PostgresGoogleIntegrationStore(database)
    : new InMemoryGoogleIntegrationStore();
  return store;
}

export async function closeGoogleIntegrationStore(): Promise<void> {
  // The database client is process-wide; API shutdown closes it once after all
  // feature stores have released their references.
  store = undefined;
}
