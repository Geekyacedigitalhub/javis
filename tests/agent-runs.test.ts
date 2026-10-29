import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { InMemoryAgentRunStore } from "../services/ai/src/run-store";
import { agentRunMaxActiveRuns } from "../services/ai/src/agent-run-concurrency";

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
  return { status: response.status, body, headers: response.headers };
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
      // Keep API background work dormant so queue lifecycle assertions are
      // deterministic; direct/synchronous compatibility paths still execute.
      FROSH_DISABLE_BACKGROUND_RUNNERS: "1",
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
    expect(body.counts).toEqual({ queued: 0, running: 0, waiting_approval: 0, completed: 0, failed: 0, cancelled: 0 });
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

  test("persists background work as queued and permits cancellation before dispatch", async () => {
    const created = await call("/v1/agent-runs", {
      method: "POST",
      body: JSON.stringify({
        goal: "Prepare a deployment plan",
        message: "Prepare a deployment plan using the current repository state.",
        background: true,
      }),
    });
    expect(created.status).toBe(202);
    expect(created.body.status).toBe("queued");
    expect(created.body.message).toBe("Prepare a deployment plan using the current repository state.");

    const queued = await call(`/v1/agent-runs/users/${USER}?status=queued`);
    expect(queued.body.runs.some((run: any) => run.id === created.body.id)).toBe(true);
    expect(queued.body.counts.queued).toBeGreaterThanOrEqual(1);

    const events = await call(`/v1/agent-runs/users/${USER}/${created.body.id}/events`);
    expect(events.body.events.map((event: any) => event.type)).toEqual(["queued"]);
    const checkpoints = await call(`/v1/agent-runs/users/${USER}/${created.body.id}/checkpoints`);
    expect(checkpoints.body.checkpoints[0]).toMatchObject({ kind: "created", status: "queued" });

    const cancelled = await call(`/v1/agent-runs/users/${USER}/${created.body.id}/cancel`, { method: "POST" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.run.status).toBe("cancelled");
    expect(cancelled.body.run.toolCalls).toEqual([]);
  });

  test("retries a stopped run as new background work without replaying its old state", async () => {
    const source = await call("/v1/agent-runs", {
      method: "POST",
      body: JSON.stringify({
        goal: "Retry this verified coding goal",
        message: "Retry this verified coding goal after checking the recorded evidence.",
        mode: "loop",
      }),
    });
    expect(source.status).toBe(201);
    expect(source.body.status).toBe("failed");
    expect(source.body.mode).toBe("loop");

    const headers = { "idempotency-key": "fresh-retry-run-0001" };
    const fresh = await call(`/v1/agent-runs/users/${USER}/${source.body.id}/retry`, { method: "POST", headers });
    expect(fresh.status).toBe(202);
    expect(fresh.body.sourceRunId).toBe(source.body.id);
    expect(fresh.body.fresh).toBe(true);
    expect(fresh.body.run.id).not.toBe(source.body.id);
    expect(fresh.body.run.mode).toBe("loop");
    expect(fresh.body.run.message).toBe("Retry this verified coding goal after checking the recorded evidence.");
    expect(fresh.body.run.status).toBe("queued");
    expect(fresh.body.run.toolCalls).toEqual([]);

    const replay = await call(`/v1/agent-runs/users/${USER}/${source.body.id}/retry`, { method: "POST", headers });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    expect(replay.body.run.id).toBe(fresh.body.run.id);

    const hidden = await call(`/v1/agent-runs/users/not-${USER}/${source.body.id}/retry`, { method: "POST" });
    expect(hidden.status).toBe(404);
  });

  test("returns an owner-scoped append-only event history", async () => {
    const created = await call("/v1/agent-runs", {
      method: "POST",
      body: JSON.stringify({ goal: "Record this run" }),
    });
    const events = await call(`/v1/agent-runs/users/${USER}/${created.body.id}/events`);
    expect(events.status).toBe(200);
    expect(events.body.events[0].type).toBe("created");
    expect(events.body.events.at(-1).status).toBe("completed");

    const hidden = await call(`/v1/agent-runs/users/not-${USER}/${created.body.id}/events`);
    expect(hidden.status).toBe(404);

    const checkpoints = await call(`/v1/agent-runs/users/${USER}/${created.body.id}/checkpoints`);
    expect(checkpoints.status).toBe(200);
    expect(checkpoints.body.checkpoints[0].kind).toBe("created");
    expect(checkpoints.body.checkpoints.at(-1).kind).toBe("completed");

    const hiddenCheckpoints = await call(`/v1/agent-runs/users/not-${USER}/${created.body.id}/checkpoints`);
    expect(hiddenCheckpoints.status).toBe(404);
  });

  test("deduplicates retried agent-run requests by an owner-scoped idempotency key", async () => {
    const headers = { "idempotency-key": "retry-safe-run-0001" };
    const first = await call("/v1/agent-runs", {
      method: "POST",
      headers,
      body: JSON.stringify({ goal: "Do this exactly once" }),
    });
    const replay = await call("/v1/agent-runs", {
      method: "POST",
      headers,
      body: JSON.stringify({ goal: "This replay must not run" }),
    });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.goal).toBe("Do this exactly once");
  });

  test("rejects an unsafe idempotency key", async () => {
    const response = await call("/v1/agent-runs", {
      method: "POST",
      headers: { "idempotency-key": "short" },
      body: JSON.stringify({ goal: "Do not create this" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("agent-run concurrency limit", () => {
  test("is bounded to a safe operational range", () => {
    expect(agentRunMaxActiveRuns(0)).toBe(1);
    expect(agentRunMaxActiveRuns(2.9)).toBe(2);
    expect(agentRunMaxActiveRuns(999)).toBe(5);
    expect(agentRunMaxActiveRuns(Number.NaN)).toBe(2);
  });
});

describe("InMemoryAgentRunStore.list", () => {
  function run(overrides: Record<string, unknown> = {}) {
    return { goal: "goal", mode: "session" as const, status: "completed" as const, toolCalls: [], ...overrides };
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

  test("keeps an owner-scoped append-only status history", async () => {
    const store = new InMemoryAgentRunStore();
    const active = await store.create(run({ status: "running", userId: "owner-a" }));
    await store.update(active.id, { status: "waiting_approval", pendingApprovalId: "approval-1" });
    await store.cancel(active.id, "owner-a");

    const events = await store.listEvents(active.id, "owner-a");
    expect(events.map((event) => event.type)).toEqual(["created", "waiting_approval", "cancelled"]);
    expect(events.map((event) => event.status)).toEqual(["running", "waiting_approval", "cancelled"]);
    expect(await store.listEvents(active.id, "owner-b")).toEqual([]);
  });

  test("keeps compact checkpoints whenever task evidence or a stopping point changes", async () => {
    const store = new InMemoryAgentRunStore();
    const active = await store.create(run({ status: "running", userId: "owner-a" }));
    await store.update(active.id, {
      toolCalls: [{ id: "tool-1", name: "workspace_list", arguments: {}, status: "completed", result: [] }],
    });
    await store.update(active.id, { status: "waiting_approval", pendingApprovalId: "approval-1" });
    await store.cancel(active.id, "owner-a");

    const checkpoints = await store.listCheckpoints(active.id, "owner-a");
    expect(checkpoints.map((checkpoint) => checkpoint.kind)).toEqual([
      "created", "tool_evidence", "awaiting_approval", "cancelled",
    ]);
    expect(checkpoints[1]?.toolCallCount).toBe(1);
    expect(await store.listCheckpoints(active.id, "owner-b")).toEqual([]);
  });

  test("creates an idempotency key only once per owner", async () => {
    const store = new InMemoryAgentRunStore();
    const first = await store.createIdempotent({ ...run({ userId: "owner-a" }), idempotencyKey: "same-request" });
    const replay = await store.createIdempotent({ ...run({ userId: "owner-a", goal: "ignored replay" }), idempotencyKey: "same-request" });
    const otherOwner = await store.createIdempotent({ ...run({ userId: "owner-b" }), idempotencyKey: "same-request" });

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.run.id).toBe(first.run.id);
    expect(otherOwner.run.id).not.toBe(first.run.id);
  });

  test("claims queued work only when an owner has capacity, and emits truthful queue history", async () => {
    const store = new InMemoryAgentRunStore(1);
    const active = await store.create(run({ status: "running", userId: "owner-a" }));
    const queued = await store.create(run({
      status: "queued", userId: "owner-a", goal: "deferred", message: "Original deferred instruction",
    }));

    // A queued row is durable but has not crossed a provider/tool boundary.
    expect(await store.claimQueued(queued.id, "owner-a")).toBeNull();
    expect((await store.get(queued.id))?.status).toBe("queued");
    expect((await store.listEvents(queued.id, "owner-a")).map((event) => event.type)).toEqual(["queued"]);

    await store.cancel(active.id, "owner-a");
    const claimed = await store.claimQueued(queued.id, "owner-a");
    expect(claimed).toMatchObject({ id: queued.id, status: "running", message: "Original deferred instruction" });
    expect((await store.listEvents(queued.id, "owner-a")).map((event) => event.type)).toEqual(["queued", "running"]);
  });

  test("preserves queued work through interrupted-run recovery", async () => {
    const store = new InMemoryAgentRunStore();
    const queued = await store.create(run({ status: "queued", userId: "owner-a" }));
    await store.create(run({ status: "running", userId: "owner-a" }));

    expect(await store.recoverInterrupted("owner-a")).toBe(1);
    expect((await store.get(queued.id))?.status).toBe("queued");
  });

  test("bounds active runs per owner and frees capacity on a terminal state", async () => {
    const store = new InMemoryAgentRunStore(1);
    const first = await store.create(run({ status: "running", userId: "owner-a" }));

    await expect(store.create(run({ status: "waiting_approval", userId: "owner-a" }))).rejects.toMatchObject({
      name: "FroshAgentRunConcurrencyError",
      limit: 1,
    });
    // Another account has an independent capacity bound.
    await expect(store.create(run({ status: "running", userId: "owner-b" }))).resolves.toMatchObject({ userId: "owner-b" });

    await store.cancel(first.id, "owner-a");
    await expect(store.create(run({ status: "running", userId: "owner-a" }))).resolves.toMatchObject({ userId: "owner-a" });
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

  test("timeout is atomic and terminal", async () => {
    const store = new InMemoryAgentRunStore();
    const active = await store.create(run({ status: "running" }));

    const timedOut = await store.timeout(active.id);
    expect(timedOut?.status).toBe("failed");
    expect(timedOut?.error).toBe("Agent run execution timed out");
    expect(timedOut?.result).toContain("did not replay");
    expect((await store.update(active.id, { status: "completed", result: "late result" })).status).toBe("failed");
    expect(await store.timeout(active.id)).toBeNull();
  });

  test("recovers interrupted running work without replaying it, but preserves approval waits", async () => {
    const store = new InMemoryAgentRunStore();
    const interrupted = await store.create(run({ status: "running", userId: "owner-a" }));
    const waiting = await store.create(run({ status: "waiting_approval", userId: "owner-a", pendingApprovalId: "approval-1" }));
    await store.create(run({ status: "running", userId: "owner-b" }));

    expect(await store.recoverInterrupted("owner-a")).toBe(1);
    const recovered = await store.get(interrupted.id);
    expect(recovered?.status).toBe("failed");
    expect(recovered?.result).toContain("not replayed");
    expect(recovered?.error).toContain("restarted");
    expect((await store.get(waiting.id))?.status).toBe("waiting_approval");
    expect(await store.recoverInterrupted("owner-a")).toBe(0);
  });
});
