import type { FroshNoteStore } from "../../../packages/types/src/note";
import { getFroshDatabaseClient } from "../../database/src";
import { InMemoryNoteStore, PostgresNoteStore } from "./store";

let store: FroshNoteStore | undefined;

export function getNoteStore(): FroshNoteStore {
  if (store) return store;
  const database = getFroshDatabaseClient();
  store = database ? new PostgresNoteStore(database) : new InMemoryNoteStore();
  return store;
}

export async function closeNoteStore(): Promise<void> {
  store = undefined;
}
