/**
 * Approval center tests.
 *
 * Boots the real router through `tests/approvals.entry.ts`, which seeds the
 * store before importing the server, so one request is already expired and two
 * are live before the first HTTP call arrives. Everything after that is driven over HTTP: listing, the expiry
 * sweep, approve, reject, double-resolve, and the auth boundary.
 *
 * Also covers InMemoryApprovalStore.list directly, because ordering, filtering
 * and the limit clamp are easier to pin from the store than through the router.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { InMemoryApprovalStore } from "../services/tools/src/approvals";

const ROOT = join(import.meta.dir, "..");
const TOKEN = "approvals-test-token";
const USER = "default-user";
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;

let proc: ReturnType<typeof Bun.spawn> | undefined;

const auth = { "x-frosh-web-token": TOKEN, "content-type": "application/json" };

async function call(path: string, init: RequestInit = {}) {
  const response = await fetch(BASE + path, {
    ...init,
    headers: { ...auth, ...(init.headers as Record<string, string> | undefined) },
  });
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
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return true;
    } catch {
      /* not listening yet */
    }
    await Bun.sleep(150);
  }
  return false;
}

beforeAll(async () => {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    PORT: String(PORT),
    FROSH_WEB_TOKEN: TOKEN,
    FROSH_DEVICE_ENROLLMENT_TOKEN: "enroll-token",
    FROSH_USER_ID: USER,
    FROSH_AUTOMATION_USER_ID: USER,
  };
  delete (env as Record<string, string | undefined>).DATABASE_URL;
  delete (env as Record<string, string | undefined>).OPENAI_API_KEY;

  // tests/approvals.entry.ts seeds the store and then imports the real server,
  // so both share one module instance. There is no other way to get an approval
  // in front of the router: the offline provider never emits tool calls.
  proc = Bun.spawn(["bun", "run", "tests/approvals.entry.ts"], {
    cwd: ROOT,
    env: env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (!(await waitForHealth())) {
    const stream = proc.stderr;
    const stderr = stream && typeof stream !== "number" ? await new Response(stream).text() : "";
    throw new Error(`API did not become healthy on ${BASE}\n${stderr}`);
  }
});

afterAll(() => {
  proc?.kill();
});

describe("approval center over HTTP", () => {
  test("requires authentication", async () => {
    const response = await fetch(`${BASE}/v1/approvals/users/${USER}`);
    expect(response.status).toBe(401);
  });

  test("lists only live requests as pending and sweeps the expired one", async () => {
    const { status, body } = await call(`/v1/approvals/users/${USER}`);
    expect(status).toBe(200);
    expect(body.approvals).toHaveLength(2);
    expect(body.counts.pending).toBe(2);
    // The third seeded request is past its deadline, so it must already be
    // expired rather than sitting in the pending list forever.
    expect(body.counts.expired).toBe(1);
    for (const approval of body.approvals) expect(approval.status).toBe("pending");
  });

  test("history returns every status", async () => {
    const { status, body } = await call(`/v1/approvals/users/${USER}?status=all`);
    expect(status).toBe(200);
    expect(body.approvals).toHaveLength(3);
  });

  test("rejects an unknown status filter", async () => {
    const { status, body } = await call(`/v1/approvals/users/${USER}?status=everything`);
    expect(status).toBe(400);
    expect(body.error).toContain("status must be one of");
  });

  test("approving performs the action and resolves the request", async () => {
    const listed = await call(`/v1/approvals/users/${USER}`);
    const target = listed.body.approvals.find((item: any) => item.toolName === "delete_memory");
    expect(target).toBeDefined();

    const { status, body } = await call(
      `/v1/approvals/users/${USER}/${target.id}/approve`,
      { method: "POST", body: "{}" },
    );
    expect(status).toBe(200);
    expect(body.approval.status).toBe("approved");
    // delete_memory with an unknown id is a harmless no-op, which makes it a
    // safe way to prove the approved tool actually ran.
    expect(body.result).toMatchObject({ accepted: false, message: "Memory not found." });
  });

  test("a resolved approval cannot be approved twice", async () => {
    const listed = await call(`/v1/approvals/users/${USER}?status=all`);
    const resolved = listed.body.approvals.find((item: any) => item.status === "approved");
    expect(resolved).toBeDefined();

    const { status, body } = await call(
      `/v1/approvals/users/${USER}/${resolved.id}/approve`,
      { method: "POST", body: "{}" },
    );
    expect(status).toBe(409);
    expect(body.error).toBe("Approval is already approved");
  });

  test("rejecting resolves without performing the action", async () => {
    const listed = await call(`/v1/approvals/users/${USER}`);
    expect(listed.body.approvals).toHaveLength(1);
    const target = listed.body.approvals[0];

    const { status, body } = await call(
      `/v1/approvals/users/${USER}/${target.id}/reject`,
      { method: "POST", body: "{}" },
    );
    expect(status).toBe(200);
    expect(body.approval.status).toBe("rejected");
    expect(body.result).toBeUndefined();
  });

  test("unknown approvals are a 404", async () => {
    const { status, body } = await call(
      `/v1/approvals/users/${USER}/00000000-0000-4000-8000-000000000000/approve`,
      { method: "POST", body: "{}" },
    );
    expect(status).toBe(404);
    expect(body.error).toBe("Approval not found");
  });

  test("counts reflect every decision", async () => {
    const { body } = await call(`/v1/approvals/users/${USER}?status=all`);
    expect(body.counts).toEqual({ pending: 0, approved: 1, rejected: 1, expired: 1 });
  });
});

describe("InMemoryApprovalStore.list", () => {
  function request(overrides: Record<string, unknown>) {
    return {
      toolName: "delete_memory",
      arguments: {},
      reason: "test",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...overrides,
    } as Parameters<InMemoryApprovalStore["create"]>[0];
  }

  test("returns newest first", async () => {
    const store = new InMemoryApprovalStore();
    const first = await store.create(request({ reason: "first" }));
    await Bun.sleep(5);
    const second = await store.create(request({ reason: "second" }));

    const listed = await store.list({ status: "all" });
    expect(listed.map((item) => item.id)).toEqual([second.id, first.id]);
  });

  test("marks an overdue request expired before returning it", async () => {
    const store = new InMemoryApprovalStore();
    await store.create(request({ expiresAt: new Date(Date.now() - 1000).toISOString() }));

    expect(await store.list({ status: "pending" })).toEqual([]);
    const all = await store.list({ status: "all" });
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("expired");
    expect(all[0].resolvedAt).toBeDefined();
  });

  test("clamps the limit", async () => {
    const store = new InMemoryApprovalStore();
    for (let index = 0; index < 5; index += 1) await store.create(request({}));

    expect(await store.list({ status: "all", limit: 2 })).toHaveLength(2);
    expect(await store.list({ status: "all", limit: 0 })).toHaveLength(1);
    expect(await store.list({ status: "all", limit: 10_000 })).toHaveLength(5);
  });

  test("filters by status", async () => {
    const store = new InMemoryApprovalStore();
    const approved = await store.create(request({}));
    await store.create(request({}));
    await store.resolve(approved.id, "approved");

    expect(await store.list({ status: "approved" })).toHaveLength(1);
    expect(await store.list({ status: "pending" })).toHaveLength(1);
    expect(await store.list({ status: "rejected" })).toHaveLength(0);
  });
});
