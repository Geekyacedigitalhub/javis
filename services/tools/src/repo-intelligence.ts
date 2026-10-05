import { registerTool } from "./registry";

const apiBase = "https://api.github.com";

function token() {
  const value = process.env.GITHUB_TOKEN;
  if (!value) throw new Error("GITHUB_TOKEN is not configured");
  return value;
}

async function github(path: string) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token()}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const text = await response.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${body?.message ?? response.statusText}`);
  return body;
}

function repo(args: Record<string, unknown>) {
  const value = String(args.repository ?? "").trim();
  if (!/^[^/]+\/[^/]+$/.test(value)) throw new Error("repository must be owner/name");
  return value;
}

function ignored(path: string) {
  return /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|\.expo)(\/|$)/.test(path)
    || /\.(lock|png|jpg|jpeg|gif|webp|ico|zip|pdf|mp4|mov)$/i.test(path);
}

async function walk(repository: string, path = "", ref?: string, depth = 0): Promise<any[]> {
  if (depth > 8) return [];
  const suffix = path ? `/${encodeURIComponent(path).replace(/%2F/g, "/")}` : "";
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const items = await github(`/repos/${repository}/contents${suffix}${query}`);
  if (!Array.isArray(items)) return [];
  const output: any[] = [];
  for (const item of items) {
    if (ignored(item.path)) continue;
    if (item.type === "file") output.push({ path: item.path, type: "file", size: item.size ?? 0, sha: item.sha });
    else if (item.type === "dir") output.push(...await walk(repository, item.path, ref, depth + 1));
  }
  return output;
}

registerTool({
  name: "github_index_repository",
  description: "Build a searchable file inventory and technology summary for an authorized GitHub repository.",
  permission: "safe",
  parameters: {
    type: "object",
    properties: { repository: { type: "string" }, ref: { type: "string" }, maxFiles: { type: "number" } },
    required: ["repository"],
    additionalProperties: false,
  },
  async execute(args) {
    const repository = repo(args);
    const files = await walk(repository, "", args.ref ? String(args.ref) : undefined);
    const maxFiles = Math.max(1, Math.min(Number(args.maxFiles ?? 2000), 5000));
    const selected = files.slice(0, maxFiles);
    const paths = selected.map((item) => item.path);
    const technologies = new Set<string>();

    if (paths.some((p) => p === "package.json" || p.endsWith("/package.json"))) technologies.add("Node.js/JavaScript/TypeScript");
    if (paths.some((p) => /(^|\/)next\.config\./.test(p))) technologies.add("Next.js");
    if (paths.some((p) => /(^|\/)tsconfig\.json$/.test(p))) technologies.add("TypeScript");
    if (paths.some((p) => /(^|\/)Dockerfile$/.test(p))) technologies.add("Docker");
    if (paths.some((p) => /(^|\/)requirements\.txt$|(^|\/)pyproject\.toml$/.test(p))) technologies.add("Python");
    if (paths.some((p) => /(^|\/)\.github\/workflows\//.test(p))) technologies.add("GitHub Actions");
    if (paths.some((p) => /(^|\/)prisma\//.test(p) || /schema\.prisma$/.test(p))) technologies.add("Prisma");

    return { repository, ref: args.ref ?? "default", fileCount: files.length, returnedFileCount: selected.length,
      truncated: files.length > selected.length, technologies: [...technologies], files: selected };
  },
});

registerTool({
  name: "github_search_code",
  description: "Search source-code paths and contents in an authorized GitHub repository.",
  permission: "safe",
  parameters: {
    type: "object",
    properties: { repository: { type: "string" }, query: { type: "string" }, maxResults: { type: "number" } },
    required: ["repository", "query"],
    additionalProperties: false,
  },
  async execute(args) {
    const repository = repo(args);
    const query = String(args.query ?? "").trim();
    if (!query) throw new Error("query is required");
    const result = await github(`/search/code?q=${encodeURIComponent(`${query}+repo:${repository}`)}&per_page=100`);
    const maxResults = Math.max(1, Math.min(Number(args.maxResults ?? 20), 100));
    return { repository, query, total: result.total_count ?? 0,
      results: (result.items ?? []).slice(0, maxResults).map((item: any) => ({ name: item.name, path: item.path, sha: item.sha, url: item.html_url })) };
  },
});

registerTool({
  name: "github_project_summary",
  description: "Summarize entry points, configuration, tests, workflows, documentation, and major source areas.",
  permission: "safe",
  parameters: {
    type: "object",
    properties: { repository: { type: "string" }, ref: { type: "string" } },
    required: ["repository"],
    additionalProperties: false,
  },
  async execute(args) {
    const repository = repo(args);
    const files = await walk(repository, "", args.ref ? String(args.ref) : undefined);
    const paths = files.map((item) => item.path);
    const pick = (patterns: RegExp[]) => paths.filter((p) => patterns.some((pattern) => pattern.test(p))).slice(0, 50);
    return {
      repository,
      sourceAreas: [...new Set(paths.filter((p) => /\.(ts|tsx|js|jsx|py|go|rs|java|kt|cs|php|rb|swift)$/.test(p)).map((p) => p.split("/")[0]).filter(Boolean))].slice(0, 30),
      entryPoints: pick([/(^|\/)(main|index|server|app|route|layout)\.(ts|tsx|js|jsx)$/]),
      configs: pick([/(^|\/)(package\.json|tsconfig\.json|vite\.config\.|next\.config\.|astro\.config\.|Dockerfile|docker-compose)/]),
      tests: pick([/(^|\/)(test|tests|__tests__)\//, /\.(test|spec)\.(ts|tsx|js|jsx)$/]),
      workflows: pick([/^\.github\/workflows\//]),
      documentation: pick([/(^|\/)(README|CONTRIBUTING|ARCHITECTURE|CHANGELOG)(\.|$)/i]),
      totalFiles: files.length,
    };
  },
});
