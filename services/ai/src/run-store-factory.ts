import type { FroshAgentRunStore } from "../../../packages/types/src/agent-run";
import { getFroshDatabaseClient } from "../../database/src";
import { InMemoryAgentRunStore } from "./run-store";
import { PostgresAgentRunStore } from "../../memory/src/agent-runs";

export function createAgentRunStore(): FroshAgentRunStore {
  const database = getFroshDatabaseClient();
  return database ? new PostgresAgentRunStore(database) : new InMemoryAgentRunStore();
}
