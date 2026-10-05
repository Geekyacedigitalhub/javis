import { registerTool } from "./registry";
import { listDevices } from "../../api/src/devices";
import { sendDeviceCommand } from "../../api/src/realtime";

registerTool({
  name: "search_android_contacts",
  description: "Search contacts on the paired Android FROSH device by name. Return only the requested matching contacts and phone numbers.",
  permission: "safe",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Contact name to search for." }
    },
    required: ["query"],
    additionalProperties: false
  },
  async execute(args) {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) return { accepted: false, message: "A contact name is required." };
    const device = listDevices().find((item) => item.platform === "android" && item.status === "online");
    if (!device) return { accepted: false, message: "No paired Android FROSH device is online." };
    return sendDeviceCommand(device.id, "contacts_search", query);
  }
});
