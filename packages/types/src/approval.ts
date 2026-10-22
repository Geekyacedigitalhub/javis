export type FroshApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface FroshApprovalRequest {
  id: string;
  runId?: string;
  toolName: string;
  arguments: Record<string, unknown>;
  reason: string;
  status: FroshApprovalStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
}

export interface FroshApprovalListFilter {
  /** "all" returns every status; anything else filters to that status. */
  status?: FroshApprovalStatus | "all";
  limit?: number;
}

export interface FroshApprovalStore {
  create(input: Omit<FroshApprovalRequest, "id" | "createdAt" | "status">): Promise<FroshApprovalRequest>;
  get(id: string): Promise<FroshApprovalRequest | null>;
  findPendingByRun(runId: string, toolName: string, argumentsHash: string): Promise<FroshApprovalRequest | null>;
  /**
   * Newest first. Implementations must mark requests that are past their
   * `expiresAt` as `expired` before returning, so a caller never has to reason
   * about a stale "pending" record.
   */
  list(filter?: FroshApprovalListFilter): Promise<FroshApprovalRequest[]>;
  resolve(id: string, status: "approved" | "rejected"): Promise<FroshApprovalRequest>;
}
