import { registerTool } from "./registry";

const apiBase = "https://api.github.com";

function token() {
  const value = process.env.GITHUB_TOKEN;
  if (!value) throw new Error("GITHUB_TOKEN is not configured");
  return value;
}

async function github(path: string, init: RequestInit = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token()}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${body?.message ?? response.statusText}`);
  return body;
}

function repository(args: Record<string, unknown>) {
  const value = String(args.repository ?? "").trim();
  if (!/^[^/]+\/[^/]+$/.test(value)) throw new Error("repository must be owner/name");
  return value;
}

registerTool({
  name: "github_read_file",
  description: "Read a file from an authorized GitHub repository.",
  permission: "safe",
  parameters: {
    type: "object",
    properties: {
      repository: { type: "string" },
      path: { type: "string" },
      ref: { type: "string" },
    },
    required: ["repository", "path"],
    additionalProperties: false,
  },
  async execute(args) {
    const repo = repository(args);
    const path = encodeURIComponent(String(args.path ?? "")).replace(/%2F/g, "/");
    const ref = args.ref ? `?ref=${encodeURIComponent(String(args.ref))}` : "";
    const body = await github(`/repos/${repo}/contents/${path}${ref}`);
    if (Array.isArray(body) || body.type !== "file") throw new Error("GitHub target is not a file");
    const content = Buffer.from(String(body.content ?? "").replace(/\n/g, ""), "base64").toString("utf8");
    return { repository: repo, path: body.path, sha: body.sha, size: body.size, content };
  },
});

registerTool({
  name: "github_list_files",
  description: "List files and directories in an authorized GitHub repository.",
  permission: "safe",
  parameters: {
    type: "object",
    properties: {
      repository: { type: "string" },
      path: { type: "string" },
      ref: { type: "string" },
    },
    required: ["repository"],
    additionalProperties: false,
  },
  async execute(args) {
    const repo = repository(args);
    const rawPath = String(args.path ?? "").replace(/^\/+|\/+$/g, "");
    const path = rawPath ? `/${encodeURIComponent(rawPath).replace(/%2F/g, "/")}` : "";
    const ref = args.ref ? `?ref=${encodeURIComponent(String(args.ref))}` : "";
    const body = await github(`/repos/${repo}/contents${path}${ref}`);
    if (!Array.isArray(body)) return { items: [body] };
    return { items: body.map((item: any) => ({ name: item.name, path: item.path, type: item.type, sha: item.sha, size: item.size })) };
  },
});

registerTool({
  name: "github_create_branch",
  description: "Create a branch in an authorized GitHub repository. Requires approval.",
  permission: "confirm",
  parameters: {
    type: "object",
    properties: { repository: { type: "string" }, branch: { type: "string" }, from: { type: "string" } },
    required: ["repository", "branch", "from"],
    additionalProperties: false,
  },
  async execute(args) {
    const repo = repository(args);
    const from = String(args.from);
    const source = await github(`/repos/${repo}/git/ref/heads/${encodeURIComponent(from)}`);
    const result = await github(`/repos/${repo}/git/refs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${String(args.branch)}`, sha: source.object.sha }),
    });
    return { repository: repo, branch: args.branch, sha: result.object.sha };
  },
});

registerTool({
  name: "github_write_file",
  description: "Create or replace a file in an authorized GitHub repository. Requires approval.",
  permission: "confirm",
  parameters: {
    type: "object",
    properties: {
      repository: { type: "string" }, path: { type: "string" }, content: { type: "string" },
      message: { type: "string" }, branch: { type: "string" },
    },
    required: ["repository", "path", "content", "message"],
    additionalProperties: false,
  },
  async execute(args) {
    const repo = repository(args);
    const rawPath = String(args.path);
    const path = encodeURIComponent(rawPath).replace(/%2F/g, "/");
    const branch = args.branch ? String(args.branch) : undefined;
    const existing = await github(`/repos/${repo}/contents/${path}${branch ? `?ref=${encodeURIComponent(branch)}` : ""}).catch(() => null);
    const payload: Record<string, unknown> = {
      message: String(args.message),
      content: Buffer.from(String(args.content), "utf8").toString("base64"),
    };
    if (branch) payload.branch = branch;
    if (existing?.sha) payload.sha = existing.sha;
    const result = await github(`/repos/${repo}/contents/${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { repository: repo, path: rawPath, branch: branch ?? "default", commitSha: result.commit?.sha, fileSha: result.content?.sha };
  },
});
