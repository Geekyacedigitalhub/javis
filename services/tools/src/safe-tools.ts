import { registerTool } from "./registry";

registerTool({
  name: "get_time",
  description: "Get the current server time.",
  permission: "safe",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async execute() {
    return { iso: new Date().toISOString() };
  },
});
