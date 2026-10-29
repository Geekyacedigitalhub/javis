import type { FroshAgentRunStore } from "../../../packages/types/src/agent-run";
import { getFroshDatabaseClient } from "../../database/src";
import { InMemoryAgentRunStore } from "./run-store";
import { PostgresAgentRunStore } from "../../memory/src/agent-runs";
import { agentRunMaxActiveRuns } from "./agent-run-concurrency";

export function createAgentRunStore(): FroshAgentRunStore {
  const database = getFroshDatabaseClient();
  const maxActiveRuns = agentRunMaxActiveRuns();
  return database ? new PostgresAgentRunStore(database, maxActiveRuns) : new InMemoryAgentRunStore(maxActiveRuns);
}
