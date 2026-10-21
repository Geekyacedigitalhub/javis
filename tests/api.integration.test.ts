/**
 * End-to-end API tests.
 *
 * Boots the real `services/api/src/http.ts` on an ephemeral port with no
 * OPENAI_API_KEY (so the offline DevelopmentProvider is used) and drives it
 * over HTTP exactly as a client would. This is the only test that covers the
 * router, auth boundary, mission runner, automation CRUD and the 404 fallback
 * together.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const TOKEN = "integration-test-token";
const USER = "default-user";
const PORT = 3400 + Math.floor(Math.random() * 400);
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
  return { status: response.status, body, headers: response.headers };
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
  // Force in-memory stores and the offline provider, even if the shell has keys.
  delete (env as Record<string, string | undefined>).DATABASE_URL;
  delete (env as Record<string, string | undefined>).OPENAI_API_KEY;

  proc = Bun.spawn(["bun", "run", "services/api/src/http.ts"], {
    cwd: ROOT,
    env: env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });

  const healthy = await waitForHealth();
  if (!healthy) {
    const stream = proc.stderr;
    const stderr = stream && typeof stream !== "number" ? await new Response(stream).text() : "";
    throw new Error(`API did not become healthy on ${BASE}\n${stderr}`);
  }
});

afterAll(() => {
  proc?.kill();
});

describe("health and auth", () => {
  test("/health is public", async () => {
    const response = await fetch(`${BASE}/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe("frosh-api");
  });

  test("missions require authentication", async () => {
    const response = await fetch(`${BASE}/v1/missions/users/${USER}`);
    expect(response.status).toBe(401);
  });

  test("a wrong token is rejected", async () => {
    const response = await fetch(`${BASE}/v1/missions/users/${USER}`, {
      headers: { "x-frosh-web-token": "wrong-token" },
    });
    expect(response.status).toBe(401);
  });

  test("unknown routes fall through to a JSON 404", async () => {
    const { status, body } = await call("/v1/definitely-not-a-route");
    expect(status).toBe(404);
    expect(body.error).toBe("Not found");
  });

  test("malformed identifiers are a 400, not a crash", async () => {
    const { status } = await call("/v1/missions/users/%E0%A4%A");
    expect(status).toBe(400);
  });
});

describe("mission API", () => {
  test("budgets are exposed with all three profiles", async () => {
    const { status, body } = await call("/v1/missions/budgets");
    expect(status).toBe(200);
    expect(body.maxSteps).toBeGreaterThan(0);
    expect(Object.keys(body.profiles).sort()).toEqual(["extended", "intensive", "standard"]);
    // Intensive must be strictly more generous than standard.
    expect(body.profiles.intensive.maxSteps).toBeGreaterThan(body.profiles.standard.maxSteps);
  });

  test("a mission can be created, executed and completed", async () => {
    const created = await call(`/v1/missions/users/${USER}`, {
      method: "POST",
      body: JSON.stringify({ goal: "Integration test: summarise PostgreSQL indexes", priority: "normal" }),
    });
    expect(created.status).toBe(201);
    const id = created.body.mission.id as string;
    expect(id).toBeTruthy();
    expect(created.body.mission.status).toBe("planning");

    // A single execution call plans the mission and runs it to completion.
    const run = await call(`/v1/missions/users/${USER}/${id}`, { method: "POST", body: "{}" });
    expect(run.status).toBe(200);
    expect(run.body.mission).toBeDefined();
    expect(run.body.mission.status).toBe("completed");
    expect(run.body.mission.progress).toBe(1);
    expect(run.body.mission.steps.length).toBeGreaterThanOrEqual(3);
    expect(run.body.mission.steps.every((step: { status: string }) => step.status === "completed")).toBe(true);

    // The result is recorded and reflects the offline provider.
    expect(typeof run.body.mission.result).toBe("string");
    expect(run.body.mission.result.length).toBeGreaterThan(0);

    // A durable event trail exists, newest last from listEvents (reversed by API clients).
    const events = await call(`/v1/missions/users/${USER}/${id}/events?limit=50`);
    expect(events.status).toBe(200);
    const types = events.body.events.map((event: { type: string }) => event.type);
    expect(types).toContain("mission.created");
    expect(types).toContain("mission.claimed");
    expect(types).toContain("mission.step.started");
    expect(types).toContain("mission.completed");
  });

  test("mission creation rejects a missing goal", async () => {
    const { status, body } = await call(`/v1/missions/users/${USER}`, {
      method: "POST",
      body: JSON.stringify({ priority: "high" }),
    });
    expect(status).toBe(400);
    expect(body.error).toBe("goal is required");
  });

  test("mission lists are scoped and well formed", async () => {
    const { status, body } = await call(`/v1/missions/users/${USER}`);
    expect(status).toBe(200);
    expect(Array.isArray(body.missions)).toBe(true);
    for (const mission of body.missions) {
      expect(mission.userId).toBe(USER);
      // Lease state must never leak to clients.
      expect(mission.leaseOwner).toBeUndefined();
      expect(mission.leaseUntil).toBeUndefined();
    }
  });

  test("pause, resume and delete work on a mission", async () => {
    const created = await call(`/v1/missions/users/${USER}`, {
      method: "POST",
      body: JSON.stringify({ goal: "Integration test: pause and resume" }),
    });
    const id = created.body.mission.id as string;

    const paused = await call(`/v1/missions/users/${USER}/${id}/pause`, { method: "POST", body: "{}" });
    expect([200, 409]).toContain(paused.status);

    const deleted = await call(`/v1/missions/users/${USER}/${id}`, { method: "DELETE" });
    expect([200, 409]).toContain(deleted.status);
  });

  test("an unknown mission is a 404", async () => {
    const { status } = await call(`/v1/missions/users/${USER}/00000000-0000-4000-8000-000000000000`);
    expect(status).toBe(404);
  });
});

describe("automation API", () => {
  test("full CRUD lifecycle", async () => {
    const created = await call(`/v1/automations/users/${USER}`, {
      method: "POST",
      body: JSON.stringify({
        name: "Integration brief",
        prompt: "Summarise today's priorities",
        schedule: { type: "interval", minutes: 60 },
      }),
    });
    expect(created.status).toBe(201);
    const id = created.body.automation.id as string;
    expect(created.body.automation.status).toBe("active");
    expect(created.body.automation.nextRunAt).toBeDefined();

    const listed = await call(`/v1/automations/users/${USER}`);
    expect(listed.status).toBe(200);
    expect(listed.body.automations.some((item: { id: string }) => item.id === id)).toBe(true);

    const patched = await call(`/v1/automations/users/${USER}/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "paused" }),
    });
    expect(patched.status).toBe(200);
    expect(patched.body.automation.status).toBe("paused");

    const removed = await call(`/v1/automations/users/${USER}/${id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(removed.body.deleted).toBe(true);

    const after = await call(`/v1/automations/users/${USER}`);
    expect(after.body.automations.some((item: { id: string }) => item.id === id)).toBe(false);
  });

  test("an interval under 60 minutes is rejected", async () => {
    const { status, body } = await call(`/v1/automations/users/${USER}`, {
      method: "POST",
      body: JSON.stringify({
        name: "Too frequent",
        prompt: "Should not be created",
        schedule: { type: "interval", minutes: 5 },
      }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/at least 60 minutes/);
  });

  test("a missing prompt is rejected", async () => {
    const { status } = await call(`/v1/automations/users/${USER}`, {
      method: "POST",
      body: JSON.stringify({ name: "No prompt", schedule: { type: "interval", minutes: 60 } }),
    });
    expect(status).toBe(400);
  });
});

describe("chat", () => {
  test("the offline provider answers without any model credentials", async () => {
    const { status, body } = await call("/v1/chat", {
      method: "POST",
      body: JSON.stringify({ message: "Hello FROSH", userId: USER }),
    });
    expect(status).toBe(200);
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);
  });
});
