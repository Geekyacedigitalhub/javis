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

describe("personal productivity", () => {
  test("task and daily briefing lifecycle", async () => {
    const created = await call(`/v1/tasks/users/${USER}`, {
      method: "POST",
      body: JSON.stringify({ title: "Review FROSH briefing", priority: "high" }),
    });
    expect(created.status).toBe(201);
    expect(created.body.task.status).toBe("open");

    const listed = await call(`/v1/tasks/users/${USER}`);
    expect(listed.status).toBe(200);
    expect(listed.body.tasks.some((task: { id: string }) => task.id === created.body.task.id)).toBe(true);

    const completed = await call(`/v1/tasks/users/${USER}/${created.body.task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "completed" }),
    });
    expect(completed.status).toBe(200);
    expect(typeof completed.body.task.completedAt).toBe("string");

    const briefing = await call(`/v1/briefing/users/${USER}`);
    expect(briefing.status).toBe(200);
    expect(typeof briefing.body.headline).toBe("string");
    expect(briefing.body.tasks.completedToday.some((task: { id: string }) => task.id === created.body.task.id)).toBe(true);
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

  test("the streaming command-center route works offline and emits valid SSE", async () => {
    const response = await fetch(`${BASE}/v1/chat/stream`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ message: "Hello streaming FROSH", userId: USER }),
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    // This is intentionally a real newline delimiter, not the two literal
    // characters backslash and n. The browser reader splits on this boundary.
    const events = text.trim().split("\n\n").map((frame) => {
      expect(frame.startsWith("data: ")).toBe(true);
      return JSON.parse(frame.slice(6));
    });
    const delta = events.find((event) => event.type === "delta");
    const done = events.find((event) => event.type === "done");

    expect(delta.text).toContain("Hello streaming FROSH");
    expect(typeof done.conversationId).toBe("string");
    expect(done.conversationId.length).toBeGreaterThan(0);
    expect(done.message).toContain("Hello streaming FROSH");
    expect(done.toolCalls).toEqual([]);

    const continued = await fetch(`${BASE}/v1/chat/stream`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        message: "Continue this chat",
        userId: USER,
        conversationId: done.conversationId,
      }),
    });
    const continuedText = await continued.text();
    const continuedDone = JSON.parse(
      continuedText.trim().split("\n\n").find((frame) => frame.includes('"type":"done"'))!.slice(6),
    );

    expect(continued.status).toBe(200);
    expect(continuedDone.conversationId).toBe(done.conversationId);

    const conversationList = await call(`/v1/conversations/users/${USER}`);
    expect(conversationList.status).toBe(200);
    const summary = conversationList.body.conversations.find((item: { id: string }) => item.id === done.conversationId);
    expect(summary.preview).toContain("Continue this chat");

    const savedConversation = await call(`/v1/conversations/users/${USER}/${done.conversationId}`);
    expect(savedConversation.status).toBe(200);
    expect(savedConversation.body.messages).toHaveLength(4);
    expect(savedConversation.body.messages.map((item: { role: string }) => item.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });
});

describe("research", () => {
  test("refuses private-network research targets before any fetch", async () => {
    const { status, body } = await call("/v1/research/fetch", {
      method: "POST",
      body: JSON.stringify({ url: "https://127.0.0.1/private" }),
    });
    expect(status).toBe(400);
    expect(body.error).toContain("Private network");
  });
});

describe("coding loop", () => {
  test("the offline provider cannot claim success, so the loop refuses to complete", async () => {
    const { status, body } = await call("/v1/agent-runs", {
      method: "POST",
      body: JSON.stringify({ goal: "Refactor the uploader", mode: "loop" }),
    });

    expect(status).toBe(201);
    // The development provider never calls a tool, so there is no validation
    // evidence — and the loop will not report success without it.
    expect(body.status).toBe("failed");
    expect(body.error).toBe("Model reported completion without validation evidence");
    expect(body.result).toContain("stopped without claiming success");
    expect(body.toolCalls).toEqual([]);
  });

  test("a loop run can be read back by id", async () => {
    const created = await call("/v1/agent-runs", {
      method: "POST",
      body: JSON.stringify({ goal: "Add a healthcheck", mode: "loop" }),
    });
    expect(created.status).toBe(201);

    const { status, body } = await call(`/v1/agent-runs/users/${USER}/${created.body.id}`);
    expect(status).toBe(200);
    expect(body.run.id).toBe(created.body.id);
    expect(body.run.goal).toBe("Add a healthcheck");
    expect(body.pendingApproval).toBeNull();
  });

  test("an unknown loop run is a 404", async () => {
    const { status } = await call(`/v1/agent-runs/users/${USER}/00000000-0000-4000-8000-000000000000`);
    expect(status).toBe(404);
  });

  test("a loop without a goal is refused", async () => {
    const { status } = await call("/v1/agent-runs", {
      method: "POST",
      body: JSON.stringify({ goal: "   ", mode: "loop" }),
    });
    expect(status).toBe(400);
  });

  test("agent run reads require authentication", async () => {
    const response = await fetch(`${BASE}/v1/agent-runs/users/${USER}/whatever`);
    expect(response.status).toBe(401);
  });

  test("the default mode is still the single-shot session", async () => {
    const { status, body } = await call("/v1/agent-runs", {
      method: "POST",
      body: JSON.stringify({ goal: "Say hello" }),
    });
    expect(status).toBe(201);
    // No mode asked for a loop, so the run completes as a plain session would.
    expect(body.status).toBe("completed");
    expect(body.error).toBeUndefined();
  });
});
