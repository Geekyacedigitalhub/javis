import { spawn } from "node:child_process";
import path from "node:path";
import { registerTool } from "./registry";

function run(command: string, cwd: string, timeoutMs: number) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Command timed out"));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode: exitCode ?? -1, stdout: stdout.slice(0, 100_000), stderr: stderr.slice(0, 100_000) });
    });
  });
}

registerTool({
  name: "workspace_run_command",
  description: "Run a developer command in the configured FROSH workspace. Requires user approval.",
  permission: "confirm",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      cwd: { type: "string" },
      timeoutMs: { type: "number" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async execute(args) {
    const command = String(args.command ?? "").trim();
    if (!command) throw new Error("command is required");

    const root = path.resolve(process.env.FROSH_WORKSPACE ?? process.cwd());
    const cwd = path.resolve(root, String(args.cwd ?? "."));
    const relative = path.relative(root, cwd);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Working directory is outside the configured FROSH workspace");
    }

    const timeoutMs = Math.max(1000, Math.min(Number(args.timeoutMs ?? 120_000), 300_000));
    return run(command, cwd, timeoutMs);
  },
});
