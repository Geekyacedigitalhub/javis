import { registerTool } from "./registry";
import { listDevices } from "../../api/src/devices";
import { sendDeviceCommand } from "../../api/src/realtime";

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
    return {
      accepted: false,
      message: "This action requires routing to the paired Android FROSH device."
    };
  }
});
