import { registerTool } from "./registry";
import { listDevices } from "../../api/src/devices";
import { sendDeviceCommand } from "../../api/src/realtime";

/**
 * Tools that reach the paired desktop machine.
 *
 * Nothing here knows how a command is delivered. The agent decides what it can
 * do and the server enforces which capabilities it was granted, so these tools
 * stay thin: find the machine, ask it, return what really happened.
 */

async function onlineDesktop() {
  const devices = await listDevices();
  return devices.find((device) => device.platform === "windows" && device.status === "online") ?? null;
}

const NO_DESKTOP = "No paired desktop FROSH machine is online.";

registerTool({
  name: "desktop_info",
  description:
    "Report the paired desktop FROSH machine: hostname, platform, release, CPU count, memory, working directory and shell.",
  permission: "safe",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    const device = await onlineDesktop();
    if (!device) return { accepted: false, message: NO_DESKTOP };
    return sendDeviceCommand(device.id, "device_info");
  },
});

registerTool({
  name: "desktop_run_command",
  description:
    "Run a command line on the paired desktop FROSH machine and return its exit code, stdout and stderr. This always requires user confirmation. Commands are capped at 14 seconds; anything slower is reported as an unknown outcome rather than a success.",
  permission: "confirm",
  parameters: {
    type: "object",
    properties: {
      commandLine: { type: "string", description: "Command line to run on the desktop machine." },
      cwd: { type: "string", description: "Working directory. Defaults to the agent's configured directory." },
      timeoutMs: { type: "number", description: "Milliseconds before the command is terminated. Capped at 14000." },
    },
    required: ["commandLine"],
    additionalProperties: false,
  },
  validate(args) {
    const commandLine = typeof args.commandLine === "string" ? args.commandLine.trim() : "";
    if (!commandLine) return "A command line is required.";
    if (commandLine.length > 4000) return "The command line is too long.";
    return null;
  },
  async execute(args) {
    // Checked again because an approved call is re-executed with the arguments
    // that were stored on the approval, not the ones this function saw first.
    const commandLine = typeof args.commandLine === "string" ? args.commandLine.trim() : "";
    if (!commandLine) return { accepted: false, message: "A command line is required." };
    if (commandLine.length > 4000) return { accepted: false, message: "The command line is too long." };

    const device = await onlineDesktop();
    if (!device) return { accepted: false, message: NO_DESKTOP };

    return sendDeviceCommand(device.id, "run_command", undefined, undefined, {
      commandLine,
      ...(typeof args.cwd === "string" && args.cwd.trim() ? { cwd: args.cwd.trim() } : {}),
      ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
    });
  },
});
