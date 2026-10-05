import { registerTool } from "./registry";
import { listDevices } from "../../api/src/devices";
import { sendDeviceCommand, sendMessageCommand } from "../../api/src/realtime";

registerTool({
  name: "open_android_app",
  description: "Open an installed Android app by its natural name on the paired FROSH Android device.",
  permission: "confirm",
  parameters: {
    type: "object",
    properties: {
      appName: { type: "string", description: "Human-friendly installed app name." }
    },
    required: ["appName"],
    additionalProperties: false
  },
  async execute(args) {
    const device = listDevices().find((item) => item.platform === "android" && item.status === "online");
    if (!device) return { accepted: false, message: "No paired Android FROSH device is online." };
    const appName = typeof args.appName === "string" ? args.appName.trim() : "";
    if (!appName) return { accepted: false, message: "An app name is required." };
    return sendDeviceCommand(device.id, "open_app", appName);
  }
});

registerTool({
  name: "open_android_dialer",
  description: "Open the phone dialer on the paired Android FROSH device.",
  permission: "safe",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    const device = listDevices().find((item) => item.platform === "android" && item.status === "online");
    if (!device) return { accepted: false, message: "No paired Android FROSH device is online." };
    return sendDeviceCommand(device.id, "open_dialer");
  }
});

registerTool({
  name: "call_android_number",
  description: "Place a phone call to a specific number on the paired Android FROSH device. This always requires user confirmation.",
  permission: "confirm",
  parameters: {
    type: "object",
    properties: { phoneNumber: { type: "string", description: "Phone number to call." } },
    required: ["phoneNumber"],
    additionalProperties: false
  },
  async execute(args) {
    const phoneNumber = typeof args.phoneNumber === "string" ? args.phoneNumber.trim() : "";
    if (!phoneNumber) return { accepted: false, message: "A phone number is required." };
    const device = listDevices().find((item) => item.platform === "android" && item.status === "online");
    if (!device) return { accepted: false, message: "No paired Android FROSH device is online." };
    return sendDeviceCommand(device.id, "call_number", phoneNumber);
  }
});

registerTool({
  name: "send_android_message",
  description: "Send an SMS to a specific phone number on the paired Android FROSH device. Requires explicit user confirmation before execution.",
  permission: "confirm",
  parameters: {
    type: "object",
    properties: {
      phoneNumber: { type: "string", description: "Phone number or resolved contact number." },
      message: { type: "string", description: "Exact message to send." }
    },
    required: ["phoneNumber", "message"],
    additionalProperties: false
  },
  async execute(args) {
    const phoneNumber = typeof args.phoneNumber === "string" ? args.phoneNumber.trim() : "";
    const message = typeof args.message === "string" ? args.message.trim() : "";
    if (!phoneNumber || !message) return { accepted: false, message: "A phone number and message are required." };
    const device = listDevices().find((item) => item.platform === "android" && item.status === "online");
    if (!device) return { accepted: false, message: "No paired Android FROSH device is online." };
    return sendMessageCommand(device.id, phoneNumber, message);
  }
});
