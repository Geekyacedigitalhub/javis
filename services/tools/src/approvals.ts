import type { FroshApprovalRequest, FroshApprovalStore } from "../../../packages/types/src/approval";

export class InMemoryApprovalStore implements FroshApprovalStore {
  private readonly requests = new Map<string, FroshApprovalRequest>();

  async create(input: Omit<FroshApprovalRequest, "id" | "createdAt" | "status">) {
    const now = new Date();
    const record: FroshApprovalRequest = {
      ...input,
      id: crypto.randomUUID(),
      status: "pending",
      createdAt: now.toISOString(),
    };
    this.requests.set(record.id, record);
    return record;
  }

  async get(id: string) {
    const record = this.requests.get(id);
    if (!record) return null;

    if (record.status === "pending" && Date.now() >= Date.parse(record.expiresAt)) {
      record.status = "expired";
      this.requests.set(id, record);
    }

    return record;
  }

  async resolve(id: string, status: "approved" | "rejected") {
    const record = await this.get(id);
    if (!record) throw new Error("Approval request not found");
    if (record.status !== "pending") throw new Error(`Approval request is already ${record.status}`);
    record.status = status;
    record.resolvedAt = new Date().toISOString();
    this.requests.set(id, record);
    return record;
  }
}
