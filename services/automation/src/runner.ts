import { getAutomationStore, calculateNextRun } from "./factory";
import { handleFroshRequest } from "../../api/src/server";

let started = false;
let stopping = false;
let tickRunning = false;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let activeTick: Promise<void> | undefined;

function configuredLeaseMs(): number {
  const configured = Number(process.env.FROSH_AUTOMATION_LEASE_MS ?? 5 * 60 * 1000);
  return Number.isFinite(configured)
    ? Math.min(30 * 60 * 1000, Math.max(60 * 1000, Math.floor(configured)))
    : 5 * 60 * 1000;
}

async function tick(): Promise<void> {
  if (tickRunning || stopping) return;
  tickRunning = true;
  try {
    const url = process.env.DATABASE_URL?.trim();
    if (!url || stopping) return;
    const store = getAutomationStore();
    const userId = process.env.FROSH_AUTOMATION_USER_ID?.trim();
    if (!userId || stopping) return;
    const items = await store.list(userId);
    const now = Date.now();
    const leaseMs = configuredLeaseMs();

    for (const item of items) {
      if (stopping) break;
      if (item.status !== "active" || !item.nextRunAt || Date.parse(item.nextRunAt) > now) continue;
      const owner = "automation-runner:" + crypto.randomUUID();
      const claimed = await store.claimDue(item.id, userId, owner, leaseMs);
      if (!claimed || stopping) {
        if (claimed && stopping) { try { await store.releaseLease(claimed.id, userId, owner); } catch {} }
        continue;
      }
      let leaseLost = false;
      const renewTimer = setInterval(() => {
        void store.renewLease(claimed.id, userId, owner, leaseMs)
          .then((renewed) => { if (!renewed) leaseLost = true; })
          .catch(() => { leaseLost = true; });
      }, Math.min(30_000, Math.max(5_000, Math.floor(leaseMs / 3))));
      try {
        if (stopping) continue;
        await handleFroshRequest({
          userId: claimed.userId,
          message: `AUTOMATION: ${claimed.name}\nExecute this scheduled task now:\n${claimed.prompt}`,
        });
        if (leaseLost || stopping) {
          if (leaseLost) console.error("FROSH automation lease lost before completion", claimed.id);
          continue;
        }
        if (claimed.schedule.type === "once") {
          const finalized = await store.updateOwned(claimed.id, userId, owner, {
            status: "completed", lastRunAt: new Date().toISOString(), nextRunAt: undefined,
          });
          if (!finalized) { console.error("FROSH automation lease lost during finalization", claimed.id); continue; }
        } else {
          const next = calculateNextRun(claimed.schedule, new Date());
          const finalized = await store.updateOwned(claimed.id, userId, owner, {
            lastRunAt: new Date().toISOString(), nextRunAt: next,
          });
          if (!finalized) { console.error("FROSH automation lease lost during finalization", claimed.id); continue; }
        }
      } catch (error) {
        const errorName = error instanceof Error && error.name ? error.name : "UnknownError";
        console.error("FROSH automation failed", claimed.id, errorName);
      } finally {
        clearInterval(renewTimer);
        try { await store.releaseLease(claimed.id, userId, owner); } catch {}
      }
    }
  } finally {
    tickRunning = false;
  }
}

function scheduleTick(): void {
  if (tickRunning || stopping) return;
  const promise = tick();
  activeTick = promise;
  void promise.finally(() => {
    if (activeTick === promise) activeTick = undefined;
  });
}

export function startAutomationRunner() {
  if (started || stopping) return;
  started = true;
  scheduleTick();
  tickTimer = setInterval(scheduleTick, 60_000);
}

export async function stopAutomationRunner() {
  if (!started) return;
  stopping = true;
  if (tickTimer) { clearInterval(tickTimer); tickTimer = undefined; }
  if (activeTick) await activeTick;
  started = false;
  stopping = false;
}
