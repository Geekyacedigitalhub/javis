import { registerTool } from "./registry";

registerTool({
  name: "get_time",
  description: "Get the current server time.",
  permission: "safe",
  async execute() {
    return { iso: new Date().toISOString() };
  },
});
