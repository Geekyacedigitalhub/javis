import { getTool } from "./registry";
import type { FroshToolCall, FroshToolExecutionContext } from "../../../packages/types/src/javis";
import type { FroshApprovalStore } from "../../../packages/types/src/approval";
import { createApprovalStore } from "./approval-store-factory";

export const approvalStore: FroshApprovalStore = createApprovalStore();

export async function executeToolCall(call: FroshToolCall, options: FroshToolExecutionContext = {}) {
  const tool = getTool(call.name);

  if (!tool) {
    return { ...call, status: "failed" as const, result: { error: `Unknown tool: ${call.name}` } };
  }

  const invalid = tool.validate?.(call.arguments) ?? null;
  if (invalid) {
    return { ...call, status: "failed" as const, result: { error: invalid } };
  }

  if (tool.permission !== "safe") {
    const argumentsHash = JSON.stringify(call.arguments);
    const existingApproval = options.runId
      ? await approvalStore.findPendingByRun(options.runId, call.name, argumentsHash)
      : null;
    if (existingApproval) {
      return {
        ...call,
        status: "failed" as const,
        result: { error: "Approval required", approvalId: existingApproval.id, approval: existingApproval },
      };
    }
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
    const result = await tool.execute(call.arguments, { userId: options.userId, runId: options.runId });
    return { ...call, status: "completed" as const, result };
  } catch (error) {
    return {
      ...call,
      status: "failed" as const,
      result: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function resolveApproval(id: string, status: "approved" | "rejected", context: FroshToolExecutionContext = {}) {
  const approval = await approvalStore.resolve(id, status);
  if (status === "rejected") return { approval, result: null };

  const tool = getTool(approval.toolName);
  if (!tool) throw new Error("Approved tool no longer exists");
  if (tool.permission === "safe") throw new Error("Safe tools do not require approval");

  const result = await tool.execute(approval.arguments, context);
  return { approval, result };
}
