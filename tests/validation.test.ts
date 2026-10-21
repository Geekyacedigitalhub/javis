/**
 * Regression tests for the two identifier/text bugs that made FROSH unusable.
 *
 * 1. Control-character guards were written as /[\\u0000-\\u001f\\u007f]/ which,
 *    inside a regex literal, matches the literal characters `\`, `u`, `0`, `1`,
 *    `f` and `7`. That made ordinary ids like "default-user" fail validation,
 *    so mission creation threw for every user.
 * 2. The corrected guard then rejected every control character including
 *    newline, so multi-line mission context could never be stored.
 */
import { describe, expect, test } from "bun:test";
import { InMemoryMissionStore } from "../services/missions/src/store";
import type { FroshMission } from "../packages/types/src/mission";

const base = {
  status: "planning" as const,
  priority: "normal" as const,
  budgetProfile: "standard" as const,
  progress: 0,
  steps: [] as FroshMission["steps"],
};

describe("identifier validation", () => {
  test("everyday user ids are accepted", async () => {
    const store = new InMemoryMissionStore();
    // These all contain characters that the double-escaped guard rejected
    // (default-user and normal-id contain u/0/1/f/7 pathologically, but the
    // important case is that none of them contain control characters).
    for (const userId of ["default-user", "user_123", "geekyace-digital-hub", "USER-42"]) {
      const mission = await store.create({ ...base, userId, goal: "Valid id test" });
      expect(mission).not.toBeNull();
      expect(mission!.userId).toBe(userId);
    }
  });

  test("the default user id specifically is accepted", async () => {
    // This exact value failed before the fix.
    const store = new InMemoryMissionStore();
    const mission = await store.create({ ...base, userId: "default-user", goal: "Default user" });
    expect(mission).not.toBeNull();
  });

  test("control characters in ids are rejected", async () => {
    const store = new InMemoryMissionStore();
    await expect(
      store.create({ ...base, userId: "bad\u0000id", goal: "Should fail" }),
    ).rejects.toThrow(/safety bounds/);
  });

  test("over-long ids are rejected", async () => {
    const store = new InMemoryMissionStore();
    await expect(
      store.create({ ...base, userId: "u".repeat(201), goal: "Too long" }),
    ).rejects.toThrow(/safety bounds/);
  });
});

describe("multi-line mission text", () => {
  test("goals containing newlines and tabs are accepted", async () => {
    const store = new InMemoryMissionStore();
    const goal = "Research MT5 backtesting\n\t- focus on Python\n\t- compare with Zorro\nThen summarise.";
    const mission = await store.create({ ...base, userId: "default-user", goal });
    expect(mission).not.toBeNull();
    expect(mission!.goal).toContain("\n");
    expect(mission!.goal).toContain("\t");
  });

  test("step context containing newlines is accepted", async () => {
    // This is the shape the mission runner actually writes: prior context plus
    // the previous result joined by blank lines.
    const store = new InMemoryMissionStore();
    const now = new Date().toISOString();
    const steps: FroshMission["steps"] = [
      {
        id: "step-1",
        title: "Understand the objective",
        status: "completed",
        context: "First finding.\n\nSecond finding.\n\nThird finding.",
        result: "Line one\nLine two",
        createdAt: now,
        updatedAt: now,
      },
    ];
    const mission = await store.create({ ...base, userId: "default-user", goal: "Multi-line step", steps });
    expect(mission).not.toBeNull();
    expect(mission!.steps[0].context).toContain("\n\n");
  });

  test("other control characters are still rejected", async () => {
    const store = new InMemoryMissionStore();
    for (const control of ["\u0000", "\u0001", "\u000b", "\u000c", "\u001b", "\u007f"]) {
      await expect(
        store.create({ ...base, userId: "default-user", goal: `bad${control}goal` }),
      ).rejects.toThrow(/safety bounds/);
    }
  });

  test("oversized goals are rejected", async () => {
    const store = new InMemoryMissionStore();
    await expect(
      store.create({ ...base, userId: "default-user", goal: "x".repeat(12_001) }),
    ).rejects.toThrow(/safety bounds/);
  });
});

describe("invalid mission state", () => {
  test("unknown status, priority and budget profile are rejected", async () => {
    const store = new InMemoryMissionStore();
    await expect(
      store.create({ ...base, userId: "default-user", goal: "x", status: "exploded" as never }),
    ).rejects.toThrow(/Invalid mission status/);
    await expect(
      store.create({ ...base, userId: "default-user", goal: "x", priority: "urgent" as never }),
    ).rejects.toThrow(/Invalid mission priority/);
    await expect(
      store.create({ ...base, userId: "default-user", goal: "x", budgetProfile: "unlimited" as never }),
    ).rejects.toThrow(/Invalid mission budget profile/);
  });

  test("duplicate step ids are rejected", async () => {
    const store = new InMemoryMissionStore();
    const now = new Date().toISOString();
    const step = {
      id: "dupe",
      title: "Step",
      status: "pending" as const,
      createdAt: now,
      updatedAt: now,
    };
    await expect(
      store.create({ ...base, userId: "default-user", goal: "dupes", steps: [step, { ...step }] }),
    ).rejects.toThrow(/duplicate step IDs/);
  });
});
