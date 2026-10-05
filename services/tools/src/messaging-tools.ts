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
