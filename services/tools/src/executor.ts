import { getTool } from "./registry";
import type { FroshToolCall } from "../../../packages/types/src/javis";
import type { FroshApprovalStore } from "../../../packages/types/src/approval";
import { createApprovalStore } from "./approval-store-factory";

export const approvalStore: FroshApprovalStore = createApprovalStore();

export async function executeToolCall(call: FroshToolCall, options: { runId?: string } = {}) {
  const tool = getTool(call.name);

  if (!tool) {
    return { ...call, status: "failed" as const, result: { error: `Unknown tool: ${call.name}` } };
  }

  if (tool.permission !== "safe") {
    const approval = await approvalStore.create({
      runId: options.runId,
      toolName: call.name,
      arguments: call.arguments,
      reason: `FROSH requested the ${call.name} action.`,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });

    return {
      ...call,
      status: "failed" as const,
      result: { error: "Approval required", approvalId: approval.id, approval },
    };
  }

  try {
    const result = await tool.execute(call.arguments);
    return { ...call, status: "completed" as const, result };
  } catch (error) {
    return {
      ...call,
      status: "failed" as const,
      result: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function resolveApproval(id: string, status: "approved" | "rejected") {
  const approval = await approvalStore.resolve(id, status);
  if (status === "rejected") return { approval, result: null };

  const tool = getTool(approval.toolName);
  if (!tool) throw new Error("Approved tool no longer exists");
  if (tool.permission === "safe") throw new Error("Safe tools do not require approval");

  const result = await tool.execute(approval.arguments);
  return { approval, result };
}
