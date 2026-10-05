import postgres from "postgres";
import type { FroshAgentRunStore } from "../../../packages/types/src/agent-run";
import { InMemoryAgentRunStore } from "./run-store";
import { PostgresAgentRunStore } from "../../memory/src/agent-runs";

export function createAgentRunStore(): FroshAgentRunStore {
  const url = process.env.DATABASE_URL;
  if (!url) return new InMemoryAgentRunStore();
  return new PostgresAgentRunStore(postgres(url, { max: 5, idle_timeout: 20, connect_timeout: 10 }));
}
