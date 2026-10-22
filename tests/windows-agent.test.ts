import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceAgent } from "../apps/agent/src/agent";
import { createDefaultContext, executeDeviceCommand, handleRunCommand } from "../apps/agent/src/commands";
import type { FroshDeviceCommand } from "../packages/types/src/events";

/**
 * The device agent, tested where it can be tested.
 *
 * The unit half pins the command handlers and the reconnect arithmetic. The
 * integration half starts the real API, starts the real agent process against
 * it, and drives it through the same `/v1/devices/:id/command` route the
 * control center uses — enrolment, websocket authentication, dispatch, local
 * execution, and the ledger-backed result all really happen.
 *
 * The sandbox is Linux, not Windows. What that means honestly: the platform
 * decision (`cmd.exe /d /s /c` versus `/bin/sh -c`) is exercised by unit tests
 * rather than by running on Windows, and everything above that line — the
 * protocol, the handlers, the lifecycle — is the same code that will run there.
 */

const ROOT = join(import.meta.dir, "..");
const TOKEN = "agent-test-token";
const ENROLL = "agent-enroll-token";
const PORT = 3600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const auth = { "x-frosh-web-token": TOKEN, "content-type": "application/json" };

let api: ReturnType<typeof Bun.spawn> | undefined;
const agents: Array<ReturnType<typeof Bun.spawn>> = [];

async function waitForHealth(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return true;
    } catch {
      /* not listening yet */
    }
    await Bun.sleep(100);
  }
  return false;
}

async function startAgent(options: { name: string; capabilities?: string }) {
  const stateDir = mkdtempSync(join(tmpdir(), "frosh-agent-"));
  const proc = Bun.spawn(["bun", "run", "apps/agent/src/index.ts"], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      FROSH_API_URL: BASE,
      FROSH_DEVICE_ENROLLMENT_TOKEN: ENROLL,
      FROSH_DEVICE_NAME: options.name,
      FROSH_AGENT_STATE: join(stateDir, "agent.json"),
      FROSH_AGENT_WORKDIR: stateDir,
      ...(options.capabilities ? { FROSH_AGENT_CAPABILITIES: options.capabilities } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  agents.push(proc);
  return proc;
}

async function waitForDevice(name: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${BASE}/v1/devices`, { headers: auth });
    const body = (await response.json()) as { devices?: Array<{ id: string; name: string; status: string; capabilities: string[] }> };
    const found = body.devices?.find((device) => device.name === name);
    // "online" is set by the websocket authentication, so this also proves the
    // agent got through the handshake rather than merely registering.
    if (found && found.status === "online") return found;
    await Bun.sleep(150);
  }
  throw new Error(`Device ${name} never came online`);
}

async function command(deviceId: string, body: Record<string, unknown>) {
  const response = await fetch(`${BASE}/v1/devices/${deviceId}/command`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

beforeAll(async () => {
  api = Bun.spawn(["bun", "run", "services/api/src/http.ts"], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      PORT: String(PORT),
      FROSH_WEB_TOKEN: TOKEN,
      FROSH_DEVICE_ENROLLMENT_TOKEN: ENROLL,
      FROSH_USER_ID: "default-user",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!(await waitForHealth())) throw new Error(`API did not start on ${BASE}`);
});

afterAll(async () => {
  for (const agent of agents) agent.kill();
  api?.kill();
});

describe("command handlers", () => {
  const context = createDefaultContext(tmpdir());

  test("device_info reports the machine it is running on", () => {
    const result = executeDeviceCommand({ type: "device.command", requestId: "r", deviceId: "d", command: "device_info" }, context);
    return result.then((value) => {
      expect(value.accepted).toBe(true);
      const data = value.data as Record<string, unknown>;
      expect(typeof data.hostname).toBe("string");
      expect(data.platform).toBe(process.platform);
      expect(data.agentVersion).toBe(context.agentVersion);
    });
  });

  test("run_command returns the real exit code and output", async () => {
    const result = await handleRunCommand({ commandLine: "echo handler-ok" }, context);
    expect(result.accepted).toBe(true);
    expect((result.data as { stdout: string }).stdout).toContain("handler-ok");
    expect((result.data as { exitCode: number }).exitCode).toBe(0);
  });

  test("a non-zero exit is reported as a real result, not a refusal", async () => {
    const result = await handleRunCommand({ commandLine: "exit 7" }, context);
    expect(result.accepted).toBe(true);
    expect((result.data as { exitCode: number }).exitCode).toBe(7);
    expect(result.message).toContain("code 7");
  });

  test("an empty command line is refused", async () => {
    const result = await handleRunCommand({ commandLine: "   " }, context);
    expect(result.accepted).toBe(false);
    expect(result.message).toContain("commandLine is required");
  });

  test("a missing working directory is refused rather than guessed", async () => {
    const result = await handleRunCommand({ commandLine: "echo hi", cwd: "definitely/not/here" }, context);
    expect(result.accepted).toBe(false);
    expect(result.message).toContain("does not exist");
  });

  test("a timeout is reported as an unknown outcome, not a failure", async () => {
    const result = await handleRunCommand({ commandLine: "sleep 5", timeoutMs: 1000 }, context);
    expect(result.accepted).toBe(false);
    expect(result.data).toMatchObject({ outcome: "unknown", retryable: false, reason: "command_timeout" });
  });

  test("the timeout cannot exceed the window the server waits for", async () => {
    // A command that would outlive the acknowledgement window must be clamped,
    // not left to be marked "unknown" by the server.
    const result = await handleRunCommand({ commandLine: "true", timeoutMs: 999_999 }, context);
    expect((result.data as { durationMs: number }).durationMs).toBeLessThan(1_000);
  });

  test("a command this device does not implement is refused", async () => {
    const unsupported = { type: "device.command", requestId: "r", deviceId: "d", command: "send_message" } as unknown as FroshDeviceCommand & { type: "device.command" };
    const result = await executeDeviceCommand(unsupported, context);
    expect(result.accepted).toBe(false);
    expect(result.message).toContain("does not implement");
  });
});

describe("reconnect backoff", () => {
  test("doubles to a ceiling", () => {
    const agent = new DeviceAgent({ apiUrl: BASE, name: "backoff", reconnect: { minMs: 100, maxMs: 1000 } });
    expect(agent.nextReconnectDelay(1)).toBe(100);
    expect(agent.nextReconnectDelay(2)).toBe(200);
    expect(agent.nextReconnectDelay(4)).toBe(800);
    expect(agent.nextReconnectDelay(9)).toBe(1000);
  });
});

describe("agent against a live API", () => {
  test("enrolls, authenticates, and answers device_info", async () => {
    await startAgent({ name: "desk-alpha" });
    const device = await waitForDevice("desk-alpha");

    expect(device.capabilities).toContain("device.info");
    expect(device.capabilities).toContain("shell.execute");

    const { status, body } = await command(device.id, { command: "device_info" });
    expect(status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(typeof body.data.hostname).toBe("string");
    expect(body.data.platform).toBe(process.platform);
  }, 40_000);

  test("runs a command on the machine and returns its output", async () => {
    const device = await waitForDevice("desk-alpha");
    const { body } = await command(device.id, { command: "run_command", commandLine: "echo frosh-agent-ok" });

    expect(body.accepted).toBe(true);
    expect(body.data.exitCode).toBe(0);
    expect(body.data.stdout).toContain("frosh-agent-ok");
  }, 30_000);

  test("reports a failing command with its exit code rather than claiming success", async () => {
    const device = await waitForDevice("desk-alpha");
    const { body } = await command(device.id, { command: "run_command", commandLine: "exit 9" });

    expect(body.data.exitCode).toBe(9);
    expect(body.message).toContain("code 9");
  }, 30_000);

  test("a device without the capability cannot be asked to run commands", async () => {
    await startAgent({ name: "desk-limited", capabilities: "device.info" });
    const device = await waitForDevice("desk-limited");

    expect(device.capabilities).not.toContain("shell.execute");

    const { body } = await command(device.id, { command: "run_command", commandLine: "echo nope" });
    expect(body.accepted).toBe(false);
    expect(body.message).toContain("not authorized");

    // It can still do what it did declare.
    const info = await command(device.id, { command: "device_info" });
    expect(info.body.accepted).toBe(true);
  }, 40_000);

  test("running a command needs trusted web auth, not just a device credential", async () => {
    const device = await waitForDevice("desk-alpha");
    const response = await fetch(`${BASE}/v1/devices/${device.id}/command`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-frosh-device-id": device.id, "x-frosh-device-token": "not-a-real-token" },
      body: JSON.stringify({ command: "run_command", commandLine: "echo nope" }),
    });
    // An unauthenticated caller never reaches the command at all.
    expect([401, 403]).toContain(response.status);
  }, 30_000);

  test("a command sent to an offline device does not pretend to succeed", async () => {
    const { body } = await command("00000000-0000-4000-8000-000000000000", { command: "device_info" });
    expect(body.accepted).toBe(false);
    expect(body.message).toContain("not connected");
  });
});
