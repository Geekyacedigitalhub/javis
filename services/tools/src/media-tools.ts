import { registerTool } from "./registry";
import { listDevices } from "../../api/src/devices";
import { sendDeviceCommand } from "../../api/src/realtime";

const actions = ["play", "pause", "toggle", "next", "previous", "stop", "volume_up", "volume_down"] as const;

registerTool({
  name: "control_android_media",
  description: "Control the active media session on the paired Android FROSH device.",
  permission: "confirm",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...actions], description: "Media action to perform." }
    },
    required: ["action"],
    additionalProperties: false
  },
  async execute(args) {
    const action = typeof args.action === "string" ? args.action : "";
    if (!actions.includes(action as (typeof actions)[number])) {
      return { accepted: false, message: "Unsupported media action." };
    }
    const device = listDevices().find((item) => item.platform === "android" && item.status === "online");
    if (!device) return { accepted: false, message: "No paired Android FROSH device is online." };
    return sendDeviceCommand(device.id, "media_control", action);
  }
});
