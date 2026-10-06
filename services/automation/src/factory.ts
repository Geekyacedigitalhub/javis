import postgres from "postgres";
import type { FroshAutomationSchedule, FroshAutomationStore } from "../../../packages/types/src/automation";
import { InMemoryAutomationStore, PostgresAutomationStore } from "./store";

let store: FroshAutomationStore | undefined;

export function getAutomationStore() {
  if (store) return store;
  const url = process.env.DATABASE_URL?.trim();
  store = url ? new PostgresAutomationStore(postgres(url, { max: 5, idle_timeout: 20 })) : new InMemoryAutomationStore();
  return store;
}

export async function closeAutomationStore(): Promise<void> {
  const current = store;
  store = undefined;
  if (current instanceof PostgresAutomationStore) await current.close();
}

export const MAX_AUTOMATION_INTERVAL_MINUTES = 30 * 24 * 60;
export const MAX_AUTOMATION_ONCE_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

export function validateAutomationSchedule(schedule: unknown): schedule is FroshAutomationSchedule {
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) return false;
  const value = schedule as Record<string, unknown>;
  if (value.type === "once") {
    if (typeof value.runAt !== "string") return false;
    const timestamp = Date.parse(value.runAt);
    return Number.isFinite(timestamp) && timestamp <= Date.now() + MAX_AUTOMATION_ONCE_HORIZON_MS;
  }
  if (value.type === "interval") {
    return Number.isInteger(value.minutes) &&
      Number(value.minutes) >= 60 &&
      Number(value.minutes) <= MAX_AUTOMATION_INTERVAL_MINUTES;
  }
  if (value.type === "daily") {
    return Number.isInteger(value.hour) && Number(value.hour) >= 0 && Number(value.hour) <= 23 &&
      Number.isInteger(value.minute) && Number(value.minute) >= 0 && Number(value.minute) <= 59;
  }
  if (value.type === "weekly") {
    return Number.isInteger(value.dayOfWeek) && Number(value.dayOfWeek) >= 0 && Number(value.dayOfWeek) <= 6 &&
      Number.isInteger(value.hour) && Number(value.hour) >= 0 && Number(value.hour) <= 23 &&
      Number.isInteger(value.minute) && Number(value.minute) >= 0 && Number(value.minute) <= 59;
  }
  return false;
}

export function calculateNextRun(schedule: FroshAutomationSchedule, from = new Date()) {
  if (!validateAutomationSchedule(schedule)) throw new Error("Invalid automation schedule");
  const next = new Date(from);
  if (schedule.type === "once") return new Date(schedule.runAt).toISOString();
  if (schedule.type === "interval") {
    const nextMs = from.getTime() + schedule.minutes * 60000;
    if (!Number.isFinite(nextMs)) throw new Error("Invalid automation interval");
    return new Date(nextMs).toISOString();
  }
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
