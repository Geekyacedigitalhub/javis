import { registerTool } from "./registry";
import { getConversationMemoryStore } from "../../memory/src/conversation-memory-factory";
import { removeMemoryFact } from "../../memory/src/conversation-memory";
import { listMemoryCandidates } from "../../memory/src/memory-candidates";

registerTool({
  name: "list_memory_candidates",
  description: "List pending FROSH memory candidates for user review. Read-only.",
  permission: "safe",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    return listMemoryCandidates("pending");
  }
});

registerTool({
  name: "delete_memory",
  description: "Delete a stored FROSH conversation memory or remove one specific fact from it.",
  permission: "confirm",
  parameters: {
    type: "object",
    properties: {
      memoryId: { type: "string" },
      fact: { type: "string", description: "Optional exact fact to remove instead of deleting the whole memory record." }
    },
    required: ["memoryId"],
    additionalProperties: false
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
  }
});
