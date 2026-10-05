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

export interface FroshApprovalStore {
  create(input: Omit<FroshApprovalRequest, "id" | "createdAt" | "status">): Promise<FroshApprovalRequest>;
  get(id: string): Promise<FroshApprovalRequest | null>;
  resolve(id: string, status: "approved" | "rejected"): Promise<FroshApprovalRequest>;
}
