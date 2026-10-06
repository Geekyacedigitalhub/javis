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

    for (const item of items) {
      if (item.status !== "active" || !item.nextRunAt || Date.parse(item.nextRunAt) > now) continue;

      try {
        await handleFroshRequest({
          userId: item.userId,
          message: `AUTOMATION: ${item.name}\nExecute this scheduled task now:\n${item.prompt}`,
        });

        if (item.schedule.type === "once") {
          await store.update(item.id, userId, {
            status: "completed",
            lastRunAt: new Date().toISOString(),
            nextRunAt: undefined,
          });
        } else {
          const next = calculateNextRun(item.schedule, new Date());
          await store.update(item.id, userId, {
            lastRunAt: new Date().toISOString(),
            nextRunAt: next,
          });
        }
      } catch (error) {
        const errorName = error instanceof Error && error.name ? error.name : "UnknownError";
        console.error("FROSH automation failed", item.id, errorName);
      }
    }
    } finally {
      tickRunning = false;
    }
  };

  void tick();
  setInterval(() => void tick(), 60_000);
}
