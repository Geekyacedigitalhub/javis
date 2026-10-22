import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tools that reach the paired desktop machine.
 *
 * The API is started *in this process* on purpose. Tool dispatch looks up the
 * live websocket registry, and that registry only holds the connections the same
 * process accepted — so a test that spawned the server separately would be
 * talking to a different map and would prove nothing. Here the tool, the
 * registry, and the socket are the same objects the real server uses.
 *
 * The agent runs as a real child process over a real websocket, so the command
 * genuinely leaves the process, is executed on the "machine", and comes back.
 */

const ROOT = join(import.meta.dir, "..");
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "desktop-tools-token";
const ENROLL = "desktop-enroll-token";
const WORKDIR = mkdtempSync(join(tmpdir(), "frosh-desktop-"));

process.env.PORT = String(PORT);
process.env.FROSH_WEB_TOKEN = TOKEN;
process.env.FROSH_DEVICE_ENROLLMENT_TOKEN = ENROLL;
process.env.FROSH_USER_ID = "default-user";
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

// Imported dynamically so the environment above is in place before anything
// reads it. http.ts serves on import.
const tools = await import("../services/tools/src");
const api = await import("../services/api/src/http");

const agents: Array<ReturnType<typeof Bun.spawn>> = [];
let agentStarted = false;

function toolCall(name: string, args: Record<string, unknown> = {}) {
  return { id: `call-${name}`, name, arguments: args, status: "planned" as const };
}

async function waitForOnlineDesktop(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${BASE}/v1/devices`, { headers: { "x-frosh-web-token": TOKEN } });
    const body = (await response.json()) as { devices?: Array<{ platform: string; status: string }> };
    if (body.devices?.some((device) => device.platform === "windows" && device.status === "online")) return true;
    await Bun.sleep(150);
  }
  throw new Error("The desktop agent never came online");
}

async function startAgent() {
  if (agentStarted) return;
  const stateDir = mkdtempSync(join(tmpdir(), "frosh-desktop-agent-"));
  agents.push(
    Bun.spawn(["bun", "run", "apps/agent/src/index.ts"], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        FROSH_API_URL: BASE,
        FROSH_DEVICE_ENROLLMENT_TOKEN: ENROLL,
        FROSH_DEVICE_NAME: "desk-tools",
        FROSH_AGENT_STATE: join(stateDir, "agent.json"),
        FROSH_AGENT_WORKDIR: WORKDIR,
      },
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  agentStarted = true;
  await waitForOnlineDesktop();
}

beforeAll(() => {
  // This file's own workspace, applied at test time so it cannot leak into
  // another file's run and cannot be overridden by one.
  process.env.FROSH_WORKSPACE = WORKDIR;
});

afterAll(async () => {
  for (const agent of agents) agent.kill();
  await api.closeApi();
});

describe("with no desktop paired", () => {
  test("desktop_info says so instead of inventing an answer", async () => {
    const result = await tools.executeToolCall(toolCall("desktop_info"));
    expect(result.status).toBe("completed");
    expect(result.result).toMatchObject({ accepted: false, message: "No paired desktop FROSH machine is online." });
  });
});

describe("with a desktop online", () => {
  test("desktop_info is safe and reports the real machine", async () => {
    await startAgent();

    const result = await tools.executeToolCall(toolCall("desktop_info"));

    // A safe tool runs without asking anyone.
    expect(result.status).toBe("completed");
    const value = result.result as { accepted: boolean; data: Record<string, unknown> };
    expect(value.accepted).toBe(true);
    expect(typeof value.data.hostname).toBe("string");
    expect(value.data.platform).toBe(process.platform);
    expect(value.data.workdir).toBe(WORKDIR);
  }, 40_000);

  test("desktop_run_command asks for approval before running anything", async () => {
    await startAgent();

    const pending = await tools.executeToolCall(toolCall("desktop_run_command", { commandLine: "echo should-not-run-yet" }));

    expect(pending.status).toBe("failed");
    const result = pending.result as { error: string; approvalId: string };
    expect(result.error).toBe("Approval required");
    expect(typeof result.approvalId).toBe("string");

    const approval = await tools.approvalStore.get(result.approvalId);
    expect(approval?.toolName).toBe("desktop_run_command");
    expect(approval?.status).toBe("pending");
  }, 40_000);

  test("approving it runs the command on the desktop and returns the real output", async () => {
    await startAgent();

    const pending = await tools.executeToolCall(toolCall("desktop_run_command", { commandLine: "echo desktop-tool-ok" }));
    const approvalId = (pending.result as { approvalId: string }).approvalId;

    const resolved = await tools.resolveApproval(approvalId, "approved");
    const value = resolved.result as { accepted: boolean; data: { exitCode: number; stdout: string } };

    expect(value.accepted).toBe(true);
    expect(value.data.exitCode).toBe(0);
    expect(value.data.stdout).toContain("desktop-tool-ok");
    expect((await tools.approvalStore.get(approvalId))?.status).toBe("approved");
  }, 40_000);

  test("a failing command comes back with its exit code, not a success claim", async () => {
    await startAgent();

    const pending = await tools.executeToolCall(toolCall("desktop_run_command", { commandLine: "exit 4" }));
    const resolved = await tools.resolveApproval((pending.result as { approvalId: string }).approvalId, "approved");
    const value = resolved.result as { data: { exitCode: number } };

    expect(value.data.exitCode).toBe(4);
  }, 40_000);

  test("a rejected command never runs", async () => {
    await startAgent();

    const pending = await tools.executeToolCall(toolCall("desktop_run_command", { commandLine: "echo nope" }));
    const approvalId = (pending.result as { approvalId: string }).approvalId;
    const rejected = await tools.resolveApproval(approvalId, "rejected");

    expect(rejected.result).toBeNull();
    expect((await tools.approvalStore.get(approvalId))?.status).toBe("rejected");
  }, 40_000);

  test("an empty command line is refused before any approval is created", async () => {
    await startAgent();

    const before = await tools.approvalStore.list({ status: "pending", limit: 200 });
    const result = await tools.executeToolCall(toolCall("desktop_run_command", { commandLine: "   " }));

    expect(result.status).toBe("failed");
    expect(result.result).toMatchObject({ error: "A command line is required." });
    // The user is never asked to approve something that could not run anyway.
    const after = await tools.approvalStore.list({ status: "pending", limit: 200 });
    expect(after).toHaveLength(before.length);
  }, 40_000);

  test("every desktop tool is registered with the right permission", async () => {
    const definitions = tools.listTools();
    const info = definitions.find((tool) => tool.name === "desktop_info");
    const run = definitions.find((tool) => tool.name === "desktop_run_command");

    expect(info?.permission).toBe("safe");
    expect(run?.permission).toBe("confirm");
  });
});
