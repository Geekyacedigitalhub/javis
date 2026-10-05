import { getTool } from "./registry";
import type { FroshToolCall } from "../../../packages/types/src/javis";

export async function executeToolCall(call: FroshToolCall) {
  const tool = getTool(call.name);

  if (!tool) {
    return { ...call, status: "failed" as const, result: { error: `Unknown tool: ${call.name}` } };
  }

  if (tool.permission !== "safe") {
    return {
      ...call,
      status: "failed" as const,
      result: {
        error: "This tool requires explicit user approval before execution.",
        permission: tool.permission,
      },
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
