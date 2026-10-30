import { afterEach, describe, expect, test } from "bun:test";
import { InMemoryMonitorStore } from "../services/monitoring/src/store";
import { closeMonitorStore, getMonitorStore } from "../services/monitoring/src/factory";
import { probeHttpMonitor } from "../services/monitoring/src/probe";
import { checkMonitorNow } from "../services/monitoring/src/runner";

const originalFetch = globalThis.fetch;

afterEach(async () => { globalThis.fetch = originalFetch; await closeMonitorStore(); });

describe("HTTP monitor store", () => {
  test("stores only public HTTPS monitors and hides runner lease state", async () => {
    const store = new InMemoryMonitorStore();
    await expect(store.create({ userId: "owner", name: "Local", url: "http://127.0.0.1", intervalMinutes: 5 })).rejects.toThrow(/HTTPS/);
    await expect(store.create({ userId: "owner", name: "Fast", url: "https://example.com", intervalMinutes: 4 })).rejects.toThrow(/intervalMinutes/);

    const created = await store.create({ userId: "owner", name: "Public site", url: "https://example.com/health", intervalMinutes: 5 });
    expect(created).toMatchObject({ userId: "owner", status: "active", health: "unknown" });
    expect(created).not.toHaveProperty("leaseOwner");

    const claimed = await store.claimNow(created.id, "owner", "worker-1", 30_000);
    expect(claimed).toMatchObject({ leaseOwner: "worker-1" });
    const saved = await store.recordCheck(created.id, "owner", "worker-1", {
      health: "down",
      lastCheckedAt: "2026-10-29T00:00:00.000Z",
      lastError: "Endpoint did not respond in time.",
      lastLatencyMs: 12_000,
      nextCheckAt: "2026-10-29T00:05:00.000Z",
    }, { type: "down", health: "down", message: "Public site: timed out", latencyMs: 12_000 });

    expect(saved).toMatchObject({ health: "down", lastError: "Endpoint did not respond in time." });
    expect(saved).not.toHaveProperty("leaseUntil");
    const events = await store.listEvents(created.id, "owner");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "down", health: "down" });
  });

  test("respects owner scope and prevents concurrent checks", async () => {
    const store = new InMemoryMonitorStore();
    const monitor = await store.create({ userId: "owner", name: "Site", url: "https://example.com", intervalMinutes: 5 });
    expect(await store.get(monitor.id, "other")).toBeNull();
    expect(await store.claimNow(monitor.id, "other", "worker", 10_000)).toBeNull();
    expect(await store.claimNow(monitor.id, "owner", "worker-a", 10_000)).not.toBeNull();
    expect(await store.claimNow(monitor.id, "owner", "worker-b", 10_000)).toBeNull();
  });
});

describe("monitor check orchestration", () => {
  test("records a down transition and a later recovery without exposing a lease", async () => {
    const store = getMonitorStore();
    const monitor = await store.create({ userId: "owner", name: "API", url: "https://8.8.8.8/status", intervalMinutes: 5 });
    globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
    const down = await checkMonitorNow(monitor.id, "owner");
    expect(down).toMatchObject({ health: "down", lastStatusCode: 503 });
    expect(down).not.toHaveProperty("leaseOwner");

    globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const recovered = await checkMonitorNow(monitor.id, "owner");
    expect(recovered).toMatchObject({ health: "healthy", lastStatusCode: 204 });
    const events = await store.listEvents(monitor.id, "owner");
    expect(events.map((event) => event.type).sort()).toEqual(["down", "recovered"]);
  });
});

describe("HTTP monitor probe", () => {
  test("never sends a private URL to fetch", async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("unexpected"); }) as unknown as typeof fetch;
    const probe = await probeHttpMonitor("https://127.0.0.1/private");
    expect(probe.health).toBe("down");
    expect(probe.error).toContain("Private network");
    expect(called).toBe(false);
  });

  test("reports a real HTTP response without reading its body", async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response("large body never consumed", { status: 204 });
    }) as unknown as typeof fetch;
    const probe = await probeHttpMonitor("https://8.8.8.8/health");
    expect(probe).toMatchObject({ health: "healthy", statusCode: 204 });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("HEAD");
  });

  test("falls back to a one-byte GET only when HEAD is unsupported", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      methods.push(String(init?.method));
      return new Response("ok", { status: methods.length === 1 ? 405 : 200 });
    }) as unknown as typeof fetch;
    const probe = await probeHttpMonitor("https://8.8.4.4/health");
    expect(probe.health).toBe("healthy");
    expect(methods).toEqual(["HEAD", "GET"]);
  });
});
