import { getFroshDatabaseClient } from "../../database/src";
import { InMemoryStore } from "./in-memory";
import { PostgresMemoryStore } from "./postgres";
import type { MemoryStore } from "./types";

export function createMemoryStore(): MemoryStore {
  const database = getFroshDatabaseClient();
  return database ? new PostgresMemoryStore(database) : new InMemoryStore();
}
