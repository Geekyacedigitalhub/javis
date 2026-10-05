import postgres from "postgres";
import type { FroshAutomationStore } from "../../../packages/types/src/automation";
import { InMemoryAutomationStore, PostgresAutomationStore } from "./store";

let store: FroshAutomationStore | undefined;

export function getAutomationStore() {
  if (store) return store;
  const url = process.env.DATABASE_URL?.trim();
  store = url ? new PostgresAutomationStore(postgres(url, { max: 5, idle_timeout: 20 })) : new InMemoryAutomationStore();
  return store;
}

export function calculateNextRun(schedule: import("../../../packages/types/src/automation").FroshAutomationSchedule, from = new Date()) {
  const next = new Date(from);
  if (schedule.type === "once") return new Date(schedule.runAt).toISOString();
  if (schedule.type === "interval") return new Date(from.getTime() + schedule.minutes * 60000).toISOString();

  if (schedule.type === "daily") {
    next.setHours(schedule.hour, schedule.minute, 0, 0);
    if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }

  next.setHours(schedule.hour, schedule.minute, 0, 0);
  let delta = (schedule.dayOfWeek - next.getDay() + 7) % 7;
  if (delta === 0 && next.getTime() <= from.getTime()) delta = 7;
  next.setDate(next.getDate() + delta);
  return next.toISOString();
}
