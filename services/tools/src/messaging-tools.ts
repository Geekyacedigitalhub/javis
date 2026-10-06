import { registerTool } from "./registry";
import { listDevices } from "../../api/src/devices";
import { sendMessageCommand, requestMessageInbox, replyToMessageCommand } from "../../api/src/realtime";

const providers = ["sms", "whatsapp", "telegram", "messenger", "instagram", "discord", "other"] as const;

registerTool({
  name: "send_android_message",
  description: "Send a message through a supported messaging provider on the paired Android FROSH device. Requires explicit user confirmation.",
  permission: "confirm",
  parameters: {
    type: "object",
    properties: {
      provider: { type: "string", enum: [...providers], description: "Messaging provider to use." },
      recipient: { type: "string", description: "Recipient name, username, phone number, or provider identifier." },
      message: { type: "string", description: "Exact message to send." }
    },
    required: ["provider", "recipient", "message"],
    additionalProperties: false
  },
  async execute(args) {
    const provider = typeof args.provider === "string" ? args.provider : "";
    const recipient = typeof args.recipient === "string" ? args.recipient.trim() : "";
    const message = typeof args.message === "string" ? args.message.trim() : "";
    if (!providers.includes(provider as (typeof providers)[number])) return { accepted: false, message: "Unsupported messaging provider." };
    if (!recipient || !message) return { accepted: false, message: "A recipient and message are required." };
    const device = listDevices().find((item) => item.platform === "android" && item.status === "online");
    if (!device) return { accepted: false, message: "No paired Android FROSH device is online." };
    return sendMessageCommand(device.id, recipient, message, provider);
  }
});

registerTool({
  name: "get_android_message_inbox",
  description: "Read recent supported messaging notifications from the paired Android FROSH device. Read-only.",
  permission: "safe",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    const device = listDevices().find((item) => item.platform === "android" && item.status === "online");
    if (!device) return { accepted: false, message: "No paired Android FROSH device is online." };
    return requestMessageInbox(device.id);
  }
});

registerTool({
  name: "reply_to_android_message",
  description: "Reply to a supported messaging notification on the paired Android FROSH device. Requires explicit user confirmation.",
  permission: "confirm",
  parameters: {
    type: "object",
    properties: {
      notificationId: { type: "string", description: "Notification identifier from the unified message inbox." },
      message: { type: "string", description: "Exact reply to send." }
    },
    required: ["notificationId", "message"],
    additionalProperties: false
  },
  async execute(args) {
    const notificationId = typeof args.notificationId === "string" ? args.notificationId.trim() : "";
    const message = typeof args.message === "string" ? args.message.trim() : "";
    if (!notificationId || !message) return { accepted: false, message: "A notification ID and reply message are required." };
    const device = listDevices().find((item) => item.platform === "android" && item.status === "online");
    if (!device) return { accepted: false, message: "No paired Android FROSH device is online." };
    return replyToMessageCommand(device.id, notificationId, message);
  }
});

registerTool({
  name: "analyze_android_messages",
  description: "Analyze recent Android messaging notifications and return concise summaries, priority, and whether each message appears to need a reply. This is read-only.",
  permission: "safe",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    const device = listDevices().find((item) => item.platform === "android" && item.status === "online");
    if (!device) return { accepted: false, message: "No paired Android FROSH device is online." };
    const inbox = await requestMessageInbox(device.id);
    if (!inbox.accepted) return inbox;
    const data = inbox.data as { messages?: Array<{ id: string; provider: string; sender?: string; text?: string; receivedAt: string; canReply: boolean }> } | undefined;
    const messages = data?.messages ?? [];
    const insights = messages.map((item) => {
      const text = (item.text ?? "").trim();
      const lower = text.toLowerCase();
      const urgent = /urgent|asap|emergency|immediately|important/.test(lower);
      const question = /\?|\bcan you\b|\bcould you\b|\bwould you\b|\bplease\b/.test(lower);
      const needsReply = Boolean(item.canReply && (question || /\bcall me\b|\blet me know\b|\bwhat do you think\b/.test(lower)));
      return {
        messageId: item.id,
        provider: item.provider,
        sender: item.sender,
        summary: text.length > 140 ? text.slice(0, 137) + "..." : text || "Message contains no text.",
        priority: urgent ? "urgent" : needsReply ? "high" : "normal",
        needsReply,
        replyReason: needsReply ? "The message appears to request a response." : undefined,
        receivedAt: item.receivedAt
      };
    });
    return { accepted: true, total: insights.length, needsReply: insights.filter((x) => x.needsReply).length, urgent: insights.filter((x) => x.priority === "urgent").length, insights };
  }
});

registerTool({
  name: "get_android_conversations",
  description: "Group recent supported messaging notifications on the paired Android device into conversations by provider and participant. Read-only.",
  permission: "safe",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    const device = listDevices().find((item) => item.platform === "android" && item.status === "online");
    if (!device) return { accepted: false, message: "No paired Android FROSH device is online." };
    return requestMessageInbox(device.id);
  }
});

registerTool({
  name: "get_conversation_memory",
  description: "Read saved FROSH context about recent messaging conversations. Read-only.",
  permission: "safe",
  parameters: {
    type: "object",
    properties: { conversationId: { type: "string", description: "Optional conversation identifier." } },
    additionalProperties: false
  },
  async execute(args) {
    const { getConversationMemoryStore } = await import("../../memory/src/conversation-memory-factory");
    const store = getConversationMemoryStore();
    const id = typeof args.conversationId === "string" ? args.conversationId.trim() : "";
    if (id) return store.get(id);
    return store.list(50);
  }
});

registerTool({
  name: "get_message_memory_candidates",
  description: "Review durable memory candidates extracted from recent supported messaging notifications. This does not automatically save them as permanent memory.",
  permission: "safe",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    const device = listDevices().find((item) => item.platform === "android" && item.status === "online");
    if (!device) return { accepted: false, message: "No paired Android FROSH device is online." };
    return requestMessageInbox(device.id);
  }
});

registerTool({
  name: "review_memory_candidates",
  description: "List pending FROSH memory candidates extracted from communication. Read-only until a candidate is explicitly approved.",
  permission: "safe",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    const { listMemoryCandidates } = await import("../../memory/src/memory-candidates");
    return listMemoryCandidates("pending");
  }
});

registerTool({
  name: "resolve_memory_candidate",
  description: "Approve or reject one FROSH memory candidate. Approval stores the candidate as durable conversation memory; rejection discards it.",
  permission: "confirm",
  parameters: {
    type: "object",
    properties: {
      candidateId: { type: "string" },
      decision: { type: "string", enum: ["approved", "rejected"] }
    },
    required: ["candidateId", "decision"],
    additionalProperties: false
  },
  async execute(args) {
    const candidateId = typeof args.candidateId === "string" ? args.candidateId.trim() : "";
    const decision = args.decision === "approved" || args.decision === "rejected" ? args.decision : "";
    if (!candidateId || !decision) return { accepted: false, message: "A candidate ID and valid decision are required." };
    const { resolveMemoryCandidate } = await import("../../memory/src/memory-candidates");
    return resolveMemoryCandidate(candidateId, decision);
  }
});
