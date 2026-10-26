import type { FroshApprovalStore } from "../../../packages/types/src/approval";
import { getFroshDatabaseClient } from "../../database/src";
import { InMemoryApprovalStore } from "./approvals";
import { PostgresApprovalStore } from "./postgres-approvals";

export function createApprovalStore(): FroshApprovalStore {
  const database = getFroshDatabaseClient();
  return database ? new PostgresApprovalStore(database) : new InMemoryApprovalStore();
}
