import type { FroshToolExecutionContext } from "../../../packages/types/src/javis";
import { registerTool } from "./registry";
import { getConversationMemoryStore } from "../../memory/src/conversation-memory-factory";
import { removeMemoryFact } from "../../memory/src/conversation-memory";
import { listUserMemoryCandidates } from "../../memory/src/memory-candidates";

function owner(context?: FroshToolExecutionContext): string {
  const userId = context?.userId?.trim();
  if (!userId) throw new Error("Personal memory is available only in an authenticated FROSH session.");
  return userId;
}

registerTool({
  name: "list_memory_candidates",
  description: "List the authenticated user's pending FROSH memory candidates for review. Read-only.",
  permission: "safe",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute(_args, context) {
    return listUserMemoryCandidates(owner(context));
  },
});

registerTool({
  name: "delete_memory",
  description: "Delete a stored FROSH conversation memory or remove one specific fact from it.",
  permission: "confirm",
  parameters: {
    type: "object",
    properties: {
      memoryId: { type: "string" },
      fact: { type: "string", description: "Optional exact fact to remove instead of deleting the whole memory record." },
    },
    required: ["memoryId"],
    additionalProperties: false,
  },
  async execute(args) {
    const memoryId = typeof args.memoryId === "string" ? args.memoryId.trim() : "";
    const fact = typeof args.fact === "string" ? args.fact.trim() : "";
    if (!memoryId) return { accepted: false, message: "A memory ID is required." };

    const store = getConversationMemoryStore();
    const memory = await store.get(memoryId);
    if (!memory) return { accepted: false, message: "Memory not found." };

    if (!fact) {
      const deleted = await store.delete(memoryId);
      return { accepted: deleted, message: deleted ? "Memory deleted." : "Memory could not be deleted." };
    }

    const updated = removeMemoryFact(memory, fact);
    if (updated.keyFacts.length === memory.keyFacts.length) {
      return { accepted: false, message: "That fact was not found in the memory." };
    }
    await store.upsert(updated);
    return { accepted: true, message: "Memory fact removed.", memory: updated };
  },
});

registerTool({
  name: "get_my_memory",
  description: "Show the approved long-term memories FROSH has stored for the authenticated user.",
  permission: "safe",
  parameters: {
    type: "object",
    properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
    additionalProperties: false,
  },
  validate(args) {
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > 100)) {
      return "limit must be an integer between 1 and 100.";
    }
    return null;
  },
  async execute(args, context) {
    const limit = typeof args.limit === "number" ? args.limit : 50;
    const { getUserMemoryStore } = await import("../../memory/src/user-memory-factory");
    return getUserMemoryStore().list(owner(context), limit);
  },
});

registerTool({
  name: "forget_my_memory",
  description: "Delete one approved long-term memory belonging to the authenticated user.",
  permission: "confirm",
  parameters: {
    type: "object",
    properties: { memoryId: { type: "string" } },
    required: ["memoryId"],
    additionalProperties: false,
  },
  async execute(args, context) {
    const memoryId = typeof args.memoryId === "string" ? args.memoryId.trim() : "";
    if (!memoryId) return { accepted: false, message: "A memory ID is required." };
    const { getUserMemoryStore } = await import("../../memory/src/user-memory-factory");
    const deleted = await getUserMemoryStore().delete(memoryId, owner(context));
    return { accepted: deleted, message: deleted ? "Long-term memory deleted." : "Memory not found for this user." };
  },
});

registerTool({
  name: "list_my_memory_candidates",
  description: "List pending memory candidates belonging only to the authenticated user.",
  permission: "safe",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute(_args, context) {
    return listUserMemoryCandidates(owner(context));
  },
});
