import { getAutomationStore, calculateNextRun } from "./factory";
import { handleFroshRequest } from "../../api/src/server";

let started = false;
let tickRunning = false;

export function startAutomationRunner() {
  if (started) return;
  started = true;

  const tick = async () => {
    if (tickRunning) return;
    tickRunning = true;
    try {
    const url = process.env.DATABASE_URL?.trim();
    if (!url) return;

    const store = getAutomationStore();
    // The current single-user runner uses FROSH_AUTOMATION_USER_ID.
    const userId = process.env.FROSH_AUTOMATION_USER_ID?.trim();
    if (!userId) return;

    const items = await store.list(userId);
    const now = Date.now();
    const configuredLeaseMs = Number(process.env.FROSH_AUTOMATION_LEASE_MS ?? 5 * 60 * 1000);
    const leaseMs = Number.isFinite(configuredLeaseMs)
      ? Math.min(30 * 60 * 1000, Math.max(60 * 1000, Math.floor(configuredLeaseMs)))
      : 5 * 60 * 1000;

    for (const item of items) {
      if (item.status !== "active" || !item.nextRunAt || Date.parse(item.nextRunAt) > now) continue;

      const owner = "automation-runner:" + crypto.randomUUID();
      const claimed = await store.claimDue(item.id, userId, owner, leaseMs);
      if (!claimed) continue;

      let leaseLost = false;
      const renewTimer = setInterval(() => {
        void store.renewLease(claimed.id, userId, owner, leaseMs)
          .then((renewed) => { if (!renewed) leaseLost = true; })
          .catch(() => { leaseLost = true; });
      }, Math.min(30_000, Math.max(5_000, Math.floor(leaseMs / 3))));

      try {
        await handleFroshRequest({
          userId: claimed.userId,
          message: `AUTOMATION: ${claimed.name}\nExecute this scheduled task now:\n${claimed.prompt}`,
        });

        if (leaseLost) {
          console.error("FROSH automation lease lost before completion", claimed.id);
          continue;
        }

        if (claimed.schedule.type === "once") {
          const finalized = await store.updateOwned(claimed.id, userId, owner, {
            status: "completed",
            lastRunAt: new Date().toISOString(),
            nextRunAt: undefined,
          });
          if (!finalized) {
            console.error("FROSH automation lease lost during finalization", claimed.id);
            continue;
          }
        } else {
          const next = calculateNextRun(claimed.schedule, new Date());
          const finalized = await store.updateOwned(claimed.id, userId, owner, {
            lastRunAt: new Date().toISOString(),
            nextRunAt: next,
          });
          if (!finalized) {
            console.error("FROSH automation lease lost during finalization", claimed.id);
            continue;
          }
        }
      } catch (error) {
        const errorName = error instanceof Error && error.name ? error.name : "UnknownError";
        console.error("FROSH automation failed", claimed.id, errorName);
      } finally {
        clearInterval(renewTimer);
        try {
          await store.releaseLease(claimed.id, userId, owner);
        } catch {
          // A stale lease is recoverable after its expiry; do not mask the runner result.
        }
      }
    }
    } finally {
      tickRunning = false;
    }
  };

  void tick();
  setInterval(() => void tick(), 60_000);
}
