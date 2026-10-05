import { registerTool } from "./registry";

registerTool({
  name: "workspace_validate",
  description: "Run a validation command in the configured workspace after an approved code change.",
  permission: "confirm",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Test, typecheck, lint, or build command." },
      cwd: { type: "string" },
      timeoutMs: { type: "number" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async execute(args) {
    const { getTool } = await import("./registry");
    const commandTool = getTool("workspace_run_command");
    if (!commandTool) throw new Error("workspace_run_command is unavailable");
    return commandTool.execute({
      command: String(args.command ?? ""),
      cwd: String(args.cwd ?? "."),
      timeoutMs: Number(args.timeoutMs ?? 120_000),
    });
  },
});

registerTool({
  name: "workspace_git_status",
  description: "Inspect Git status in the configured workspace.",
  permission: "safe",
  parameters: {
    type: "object",
    properties: { cwd: { type: "string" } },
    additionalProperties: false,
  },
  async execute(args) {
    const { getTool } = await import("./registry");
    const commandTool = getTool("workspace_run_command");
    if (!commandTool) throw new Error("workspace_run_command is unavailable");
    return commandTool.execute({ command: "git status --short --branch", cwd: String(args.cwd ?? ".") });
  },
});

registerTool({
  name: "workspace_git_diff",
  description: "Inspect the current Git diff in the configured workspace.",
  permission: "safe",
  parameters: {
    type: "object",
    properties: { cwd: { type: "string" } },
    additionalProperties: false,
  },
  async execute(args) {
    const { getTool } = await import("./registry");
    const commandTool = getTool("workspace_run_command");
    if (!commandTool) throw new Error("workspace_run_command is unavailable");
    return commandTool.execute({ command: "git diff --", cwd: String(args.cwd ?? ".") });
  },
});
