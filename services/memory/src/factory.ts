import postgres from "postgres";
import { InMemoryStore } from "./in-memory";
import { PostgresMemoryStore } from "./postgres";
import type { MemoryStore } from "./types";

export function createMemoryStore(): MemoryStore {
  const url = process.env.DATABASE_URL;

  if (!url) return new InMemoryStore();

  const sql = postgres(url, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  return new PostgresMemoryStore(sql);
}
