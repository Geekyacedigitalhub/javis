import postgres from "postgres";
import type { FroshApprovalStore } from "../../../packages/types/src/approval";
import { InMemoryApprovalStore } from "./approvals";
import { PostgresApprovalStore } from "./postgres-approvals";

export function createApprovalStore(): FroshApprovalStore {
  const url = process.env.DATABASE_URL;
  if (!url) return new InMemoryApprovalStore();
  return new PostgresApprovalStore(
    postgres(url, { max: 5, idle_timeout: 20, connect_timeout: 10 }),
  );
}
