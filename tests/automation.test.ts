/**
 * Automation scheduling rules.
 *
 * Interval automations are floored at 60 minutes on purpose: a shorter floor
 * lets a single automation burn unbounded model spend. These tests pin both the
 * boundary and the next-run arithmetic so that rule cannot be relaxed silently.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_AUTOMATION_INTERVAL_MINUTES,
  calculateNextRun,
  validateAutomationSchedule,
} from "../services/automation/src/factory";

describe("schedule validation", () => {
  test("interval must be at least 60 minutes", () => {
    expect(validateAutomationSchedule({ type: "interval", minutes: 60 })).toBe(true);
    expect(validateAutomationSchedule({ type: "interval", minutes: 59 })).toBe(false);
    expect(validateAutomationSchedule({ type: "interval", minutes: 1 })).toBe(false);
  });

  test("interval is capped", () => {
    expect(validateAutomationSchedule({ type: "interval", minutes: MAX_AUTOMATION_INTERVAL_MINUTES })).toBe(true);
    expect(validateAutomationSchedule({ type: "interval", minutes: MAX_AUTOMATION_INTERVAL_MINUTES + 1 })).toBe(false);
  });

  test("interval rejects non-integers and strings", () => {
    expect(validateAutomationSchedule({ type: "interval", minutes: 90.5 })).toBe(false);
    expect(validateAutomationSchedule({ type: "interval", minutes: "90" })).toBe(false);
  });

  test("daily bounds", () => {
    expect(validateAutomationSchedule({ type: "daily", hour: 0, minute: 0 })).toBe(true);
    expect(validateAutomationSchedule({ type: "daily", hour: 23, minute: 59 })).toBe(true);
    expect(validateAutomationSchedule({ type: "daily", hour: 24, minute: 0 })).toBe(false);
    expect(validateAutomationSchedule({ type: "daily", hour: 9, minute: 60 })).toBe(false);
  });

  test("weekly bounds", () => {
    expect(validateAutomationSchedule({ type: "weekly", dayOfWeek: 0, hour: 9, minute: 0 })).toBe(true);
    expect(validateAutomationSchedule({ type: "weekly", dayOfWeek: 6, hour: 9, minute: 0 })).toBe(true);
    expect(validateAutomationSchedule({ type: "weekly", dayOfWeek: 7, hour: 9, minute: 0 })).toBe(false);
  });

  test("once requires a parseable future timestamp within the horizon", () => {
    expect(validateAutomationSchedule({ type: "once", runAt: new Date(Date.now() + 60_000).toISOString() })).toBe(true);
    expect(validateAutomationSchedule({ type: "once", runAt: "not-a-date" })).toBe(false);
    // Beyond the one-year horizon.
    expect(
      validateAutomationSchedule({ type: "once", runAt: new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString() }),
    ).toBe(false);
  });

  test("unknown and malformed schedules are rejected", () => {
    expect(validateAutomationSchedule({ type: "hourly" })).toBe(false);
    expect(validateAutomationSchedule({})).toBe(false);
    expect(validateAutomationSchedule(null)).toBe(false);
    expect(validateAutomationSchedule([])).toBe(false);
    expect(validateAutomationSchedule("daily")).toBe(false);
  });
});

describe("next run calculation", () => {
  // calculateNextRun returns an ISO string, not a Date.
  test("interval adds the configured minutes", () => {
    const from = new Date("2026-01-01T10:00:00.000Z");
    expect(calculateNextRun({ type: "interval", minutes: 90 }, from)).toBe("2026-01-01T11:30:00.000Z");
  });

  test("daily always moves forward", () => {
    const from = new Date("2026-01-01T10:00:00.000Z");
    const next = calculateNextRun({ type: "daily", hour: 9, minute: 0 }, from);
    expect(typeof next).toBe("string");
    expect(Date.parse(next)).toBeGreaterThan(from.getTime());
    // And lands at 09:00 local time, tomorrow, since 09:00 already passed.
    const parsed = new Date(next);
    expect(parsed.getHours()).toBe(9);
    expect(parsed.getMinutes()).toBe(0);
  });

  test("weekly lands on the requested weekday in the future", () => {
    const from = new Date("2026-01-01T10:00:00.000Z");
    const next = calculateNextRun({ type: "weekly", dayOfWeek: 3, hour: 9, minute: 0 }, from);
    expect(Date.parse(next)).toBeGreaterThan(from.getTime());
    expect(new Date(next).getDay()).toBe(3);
  });

  test("once returns the scheduled timestamp unchanged", () => {
    const runAt = new Date(Date.now() + 3_600_000).toISOString();
    expect(calculateNextRun({ type: "once", runAt })).toBe(runAt);
  });

  test("an invalid schedule throws rather than guessing", () => {
    expect(() => calculateNextRun({ type: "interval", minutes: 5 })).toThrow(/Invalid automation schedule/);
  });
});
