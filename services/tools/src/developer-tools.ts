import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { registerTool } from "./registry";

const workspaceRoot = path.resolve(process.env.FROSH_WORKSPACE ?? process.cwd());

function safePath(relativePath: string) {
  const resolved = path.resolve(workspaceRoot, relativePath);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path is outside the configured FROSH workspace");
  }
  return resolved;
}

registerTool({
  name: "workspace_list",
  description: "List files and directories inside the configured FROSH coding workspace.",
  permission: "safe",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Workspace-relative directory path." } },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(args) {
    const target = safePath(String(args.path ?? "."));
    const entries = await readdir(target, { withFileTypes: true });
    return entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }));
  },
});

registerTool({
  name: "workspace_read",
  description: "Read a text file inside the configured FROSH coding workspace.",
  permission: "safe",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Workspace-relative file path." } },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(args) {
    const relativePath = String(args.path ?? "");
    const target = safePath(relativePath);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("Target is not a file");
    if (info.size > 2_000_000) throw new Error("File is too large for direct reading");
    return { path: relativePath, content: await readFile(target, "utf8") };
  },
});

registerTool({
  name: "workspace_write",
  description: "Write or replace a text file inside the configured FROSH coding workspace.",
  permission: "confirm",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async execute(args) {
    const relativePath = String(args.path ?? "");
    const target = safePath(relativePath);
    const content = String(args.content ?? "");
    if (content.length > 5_000_000) throw new Error("Content is too large");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    return { path: relativePath, bytes: Buffer.byteLength(content, "utf8") };
  },
});
