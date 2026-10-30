import type { FroshMonitorStore } from "../../../packages/types/src/monitoring";
import { getFroshDatabaseClient } from "../../database/src";
import { InMemoryMonitorStore, PostgresMonitorStore } from "./store";

let store: FroshMonitorStore | undefined;

export function getMonitorStore(): FroshMonitorStore {
  if (store) return store;
  const database = getFroshDatabaseClient();
  store = database ? new PostgresMonitorStore(database) : new InMemoryMonitorStore();
  return store;
}

export async function closeMonitorStore(): Promise<void> {
  store = undefined;
}
