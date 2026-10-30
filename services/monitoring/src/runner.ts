import type { FroshHttpMonitor, FroshMonitorEventType } from "../../../packages/types/src/monitoring";
import { closeMonitorStore, getMonitorStore } from "./factory";
import { probeHttpMonitor } from "./probe";

const DEFAULT_LEASE_MS = 45_000;
const DEFAULT_TICK_MS = 30_000;
let started = false;
let stopping = false;
let tickRunning = false;
let timer: ReturnType<typeof setInterval> | undefined;
let activeTick: Promise<void> | undefined;

function leaseMs(): number {
  const value = Number(process.env.FROSH_MONITOR_LEASE_MS ?? DEFAULT_LEASE_MS);
  // A probe can consume two 12-second requests (HEAD then bounded GET), plus
  // DNS and scheduler overhead. Never permit a lease shorter than that work.
  return Number.isFinite(value) ? Math.min(120_000, Math.max(30_000, Math.floor(value))) : DEFAULT_LEASE_MS;
}

function tickMs(): number {
  const value = Number(process.env.FROSH_MONITOR_TICK_MS ?? DEFAULT_TICK_MS);
  return Number.isFinite(value) ? Math.min(5 * 60_000, Math.max(10_000, Math.floor(value))) : DEFAULT_TICK_MS;
}

function nextCheck(monitor: FroshHttpMonitor, checkedAt: string): string {
  return new Date(Date.parse(checkedAt) + monitor.intervalMinutes * 60_000).toISOString();
}

function transition(monitor: FroshHttpMonitor, health: "healthy" | "degraded" | "down", message: string, statusCode?: number, latencyMs?: number) {
  if (monitor.health === health) return undefined;
  const type: FroshMonitorEventType = health === "healthy" && monitor.health !== "unknown" ? "recovered" : health;
  return { type, health, message: `${monitor.name}: ${message}`, statusCode, latencyMs };
}

/** Performs one claimed check. The same function powers an explicit Check now. */
export async function performMonitorCheck(monitor: FroshHttpMonitor, owner: string) {
  const store = getMonitorStore();
  const probe = await probeHttpMonitor(monitor.url);
  const event = transition(monitor, probe.health, probe.message, probe.statusCode, probe.latencyMs);
  return store.recordCheck(monitor.id, monitor.userId, owner, {
    health: probe.health,
    lastCheckedAt: probe.checkedAt,
    lastHealthyAt: probe.health === "healthy" ? probe.checkedAt : monitor.lastHealthyAt,
    lastStatusCode: probe.statusCode,
    lastLatencyMs: probe.latencyMs,
    lastError: probe.error,
    nextCheckAt: nextCheck(monitor, probe.checkedAt),
  }, event);
}

/** Immediate owner-requested check; the active lease prevents a duplicate worker probe. */
export async function checkMonitorNow(id: string, userId: string) {
  const store = getMonitorStore();
  const owner = `monitor-manual:${crypto.randomUUID()}`;
  const claimed = await store.claimNow(id, userId, owner, leaseMs());
  if (!claimed) return null;
  try {
    return await performMonitorCheck(claimed, owner);
  } catch (error) {
    await store.releaseLease(id, userId, owner).catch(() => undefined);
    throw error;
  }
}

async function tick() {
  if (tickRunning || stopping) return;
  tickRunning = true;
  try {
    // Scheduled monitoring requires durability. In-memory mode still supports
    // user-requested checks, but does not pretend it can survive a restart.
    if (!process.env.DATABASE_URL?.trim()) return;
    const store = getMonitorStore();
    const due = await store.listDue(new Date(), 20);
    await Promise.all(due.map(async (monitor) => {
      if (stopping) return;
      const owner = `monitor-runner:${crypto.randomUUID()}`;
      const claimed = await store.claimDue(monitor.id, monitor.userId, owner, leaseMs());
      if (!claimed) return;
      try {
        await performMonitorCheck(claimed, owner);
      } catch (error) {
        await store.releaseLease(claimed.id, claimed.userId, owner).catch(() => undefined);
        const name = error instanceof Error && error.name ? error.name : "UnknownError";
        console.error("FROSH monitor check failed", claimed.id, name);
      }
    }));
  } finally {
    tickRunning = false;
  }
}

function scheduleTick() {
  if (tickRunning || stopping) return;
  const task = tick();
  activeTick = task;
  void task.finally(() => { if (activeTick === task) activeTick = undefined; });
}

export function startMonitorRunner() {
  if (started || stopping || process.env.FROSH_MONITORING_ENABLED === "0") return;
  started = true;
  scheduleTick();
  timer = setInterval(scheduleTick, tickMs());
}

export async function stopMonitorRunner() {
  if (!started) return;
  stopping = true;
  try {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (activeTick) await activeTick;
    await closeMonitorStore();
  } finally {
    started = false;
    stopping = false;
  }
}
