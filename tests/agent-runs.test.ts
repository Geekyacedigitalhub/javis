import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { InMemoryAgentRunStore } from "../services/ai/src/run-store";

/**
 * Reading back what FROSH did.
 *
 * The runs endpoint is what makes the coding loop visible: without it a run's
 * evidence exists only inside the process that produced it. The integration
 * half creates real runs through the real router and reads them back.
 */

const ROOT = join(import.meta.dir, "..");
const TOKEN = "runs-test-token";
const USER = "default-user";
const PORT = 3700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const auth = { "x-frosh-web-token": TOKEN, "content-type": "application/json" };

let proc: ReturnType<typeof Bun.spawn> | undefined;

async function call(path: string, init: RequestInit = {}) {
  const response = await fetch(BASE + path, { ...init, headers: { ...auth, ...(init.headers as Record<string, string> | undefined) } });
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function waitForHealth(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return true;
    } catch {
      /* not listening yet */
    }
    await Bun.sleep(120);
  }
  return false;
}

beforeAll(async () => {
  proc = Bun.spawn(["bun", "run", "services/api/src/http.ts"], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      PORT: String(PORT),
      FROSH_WEB_TOKEN: TOKEN,
      FROSH_DEVICE_ENROLLMENT_TOKEN: "runs-enroll",
      FROSH_USER_ID: USER,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!(await waitForHealth())) throw new Error(`API did not start on ${BASE}`);
});

afterAll(() => {
  proc?.kill();
});

describe("reading runs back", () => {
  test("requires authentication", async () => {
    const response = await fetch(`${BASE}/v1/agent-runs/users/${USER}`);
    expect(response.status).toBe(401);
  });

  test("does not let a web caller select another run owner in the URL", async () => {
    const listed = await call("/v1/agent-runs/users/another-user");
    expect(listed.status).toBe(403);

    const detail = await call("/v1/agent-runs/users/another-user/00000000-0000-4000-8000-000000000000");
    expect(detail.status).toBe(404);
  });

  test("exposes a scoped cancellation endpoint without leaking unknown runs", async () => {
    const response = await call(`/v1/agent-runs/users/${USER}/00000000-0000-4000-8000-000000000000/cancel`, { method: "POST" });
    expect(response.status).toBe(404);
  });

  test("a new server has no runs", async () => {
    const { status, body } = await call(`/v1/agent-runs/users/${USER}`);
    expect(status).toBe(200);
    expect(body.runs).toEqual([]);
    expect(body.counts).toEqual({ running: 0, waiting_approval: 0, completed: 0, failed: 0, cancelled: 0 });
  });

  test("a loop run that could not prove its work is listed as failed", async () => {
    const created = await call("/v1/agent-runs", {
      method: "POST",
      body: JSON.stringify({ goal: "Tidy the uploader", mode: "loop" }),
    });
    expect(created.status).toBe(201);

    const { body } = await call(`/v1/agent-runs/users/${USER}`);
    const run = body.runs.find((item: any) => item.id === created.body.id);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("Model reported completion without validation evidence");
    // The evidence is visible in the listing, not only in the result text.
    expect(run.toolCalls).toEqual([]);
  });

  test("a completed run and a failed one are counted separately", async () => {
    await Bun.sleep(5);
    const completed = await call("/v1/agent-runs", {
      method: "POST",
      body: JSON.stringify({ goal: "Say hello" }),
    });
    expect(completed.body.status).toBe("completed");

    const { body } = await call(`/v1/agent-runs/users/${USER}`);
    expect(body.counts.completed).toBe(1);
    expect(body.counts.failed).toBe(1);
    expect(body.counts.running).toBe(0);
  });

  test("runs come back newest first", async () => {
    const { body } = await call(`/v1/agent-runs/users/${USER}`);
    expect(body.runs.length).toBeGreaterThan(1);
    const times = body.runs.map((run: any) => run.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  test("the status filter only returns that status", async () => {
    const { body } = await call(`/v1/agent-runs/users/${USER}?status=failed`);
    expect(body.runs.length).toBe(1);
    expect(body.runs[0].status).toBe("failed");
    // Counts still describe the whole set, so the console can show tabs.
    expect(body.counts.completed).toBe(1);
  });

  test("the limit is honoured and clamped", async () => {
    const one = await call(`/v1/agent-runs/users/${USER}?limit=1`);
    expect(one.body.runs).toHaveLength(1);

    const silly = await call(`/v1/agent-runs/users/${USER}?limit=99999`);
    expect(silly.status).toBe(200);
    expect(silly.body.runs.length).toBeLessThanOrEqual(200);
  });

  test("an unknown status is rejected rather than ignored", async () => {
    const { status, body } = await call(`/v1/agent-runs/users/${USER}?status=everything`);
    expect(status).toBe(400);
    expect(body.error).toContain("status must be one of");
  });
});

describe("InMemoryAgentRunStore.list", () => {
  function run(overrides: Record<string, unknown> = {}) {
    return { goal: "goal", status: "completed" as const, toolCalls: [], ...overrides };
  }

  test("returns the newest run first", async () => {
    const store = new InMemoryAgentRunStore();
    const first = await store.create(run({ goal: "first" }));
    await Bun.sleep(5);
    const second = await store.create(run({ goal: "second" }));

    const listed = await store.list();
    expect(listed.map((item) => item.id)).toEqual([second.id, first.id]);
  });

  test("filters by status", async () => {
    const store = new InMemoryAgentRunStore();
    await store.create(run({ status: "failed" }));
    await store.create(run({ status: "completed" }));

    expect(await store.list({ status: "failed" })).toHaveLength(1);
    expect(await store.list({ status: "all" })).toHaveLength(2);
  });

  test("clamps the limit", async () => {
    const store = new InMemoryAgentRunStore();
    for (let index = 0; index < 4; index += 1) await store.create(run());

    expect(await store.list({ limit: 2 })).toHaveLength(2);
    expect(await store.list({ limit: 0 })).toHaveLength(1);
    expect(await store.list({ limit: 10_000 })).toHaveLength(4);
  });

  test("keeps runs scoped to their owner", async () => {
    const store = new InMemoryAgentRunStore();
    const mine = await store.create(run({ userId: "owner-a" }));
    await store.create(run({ userId: "owner-b" }));

    expect((await store.list({ userId: "owner-a" })).map((entry) => entry.id)).toEqual([mine.id]);
  });

  test("cancellation is atomic and terminal", async () => {
    const store = new InMemoryAgentRunStore();
    const active = await store.create(run({ status: "running", userId: "owner-a" }));

    expect(await store.cancel(active.id, "owner-b")).toBeNull();
    const cancelled = await store.cancel(active.id, "owner-a");
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.pendingApprovalId).toBeUndefined();

    const late = await store.update(active.id, { status: "completed", result: "late provider output" });
    expect(late.status).toBe("cancelled");
    expect(late.result).toContain("Cancelled by the user");
    expect(await store.cancel(active.id, "owner-a")).toBeNull();
  });
});
