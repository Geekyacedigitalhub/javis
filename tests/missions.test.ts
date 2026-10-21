/**
 * Mission store behaviour.
 *
 * Covers the lease lifecycle the API relies on (claim -> owned update ->
 * release) and the quota fence that stops unbounded mission creation.
 */
import { describe, expect, test } from "bun:test";
import { InMemoryMissionStore } from "../services/missions/src/store";
import { planMission } from "../services/missions/src/planner";
import type { FroshMission } from "../packages/types/src/mission";

const USER = "default-user";

function newMission(overrides: Partial<Omit<FroshMission, "id" | "createdAt" | "updatedAt">> = {}) {
  return {
    userId: USER,
    goal: "Summarise PostgreSQL indexes",
    status: "planning" as const,
    priority: "normal" as const,
    budgetProfile: "standard" as const,
    progress: 0,
    steps: [] as FroshMission["steps"],
    ...overrides,
  };
}

describe("mission lifecycle", () => {
  test("create -> claim -> execute steps -> complete", async () => {
    const store = new InMemoryMissionStore();

    const created = await store.create(newMission());
    expect(created).not.toBeNull();
    expect(created!.status).toBe("planning");
    expect(created!.progress).toBe(0);

    const steps = planMission(created!.goal);
    expect(steps.length).toBeGreaterThanOrEqual(3);

    // A worker claims the mission, which takes a lease.
    const owner = "worker-1";
    const claimed = await store.claim(created!.id, USER, owner);
    expect(claimed).not.toBeNull();
    expect(claimed!.leaseOwner).toBe(owner);
    expect(claimed!.leaseUntil).toBeDefined();
    expect(Date.parse(claimed!.leaseUntil!)).toBeGreaterThan(Date.now());

    // Releasing the lease lets the next worker in.
    expect(await store.releaseLeaseIfOwned(created!.id, USER, owner)).toBe(true);
    expect(await store.releaseLeaseIfOwned(created!.id, USER, owner)).toBe(false);

    // Drive every step to completed through an owned update.
    const done = steps.map((step) => ({ ...step, status: "completed" as const }));
    const updated = await store.updateOwned(created!.id, USER, owner, {
      status: "completed",
      steps: done,
      progress: 1,
    });
    // The lease was released above, so this worker no longer owns it.
    expect(updated).toBeNull();

    const reclaimed = await store.claim(created!.id, USER, owner);
    expect(reclaimed).not.toBeNull();
    const completed = await store.updateOwned(created!.id, USER, owner, {
      status: "completed",
      steps: done,
      progress: 1,
      toolCallsUsed: 0,
      executionDurationMs: 5,
    });
    expect(completed).not.toBeNull();
    expect(completed!.status).toBe("completed");
    expect(completed!.progress).toBe(1);
    expect(completed!.steps.every((step) => step.status === "completed")).toBe(true);
    expect(await store.listEvents(created!.id, USER)).toEqual([]);
  });

  test("a lease blocks a second worker", async () => {
    const store = new InMemoryMissionStore();
    const mission = await store.create(newMission());
    const first = await store.claim(mission!.id, USER, "worker-a");
    expect(first).not.toBeNull();

    const second = await store.claim(mission!.id, USER, "worker-b");
    expect(second).toBeNull();
  });

  test("updateOwned rejects a worker that does not own the lease", async () => {
    const store = new InMemoryMissionStore();
    const mission = await store.create(newMission());
    await store.claim(mission!.id, USER, "worker-a");

    const stolen = await store.updateOwned(mission!.id, USER, "worker-b", { status: "running" });
    expect(stolen).toBeNull();
  });

  test("events are recorded against the mission for its owner only", async () => {
    const store = new InMemoryMissionStore();
    const mission = await store.create(newMission());
    const steps = planMission(mission!.goal);

    await store.update(mission!.id, USER, { steps });
    const event = await store.addEvent({
      missionId: mission!.id,
      userId: USER,
      type: "mission.claimed",
      message: "Mission execution started.",
    });

    expect(event.missionId).toBe(mission!.id);
    const listed = await store.listEvents(mission!.id, USER);
    expect(listed).toHaveLength(1);
    expect(listed[0].type).toBe("mission.claimed");

    // Another user must not see the events.
    expect(await store.listEvents(mission!.id, "someone-else")).toEqual([]);
  });

  test("the active-mission quota is enforced", async () => {
    const store = new InMemoryMissionStore();
    const previous = process.env.FROSH_MAX_ACTIVE_MISSIONS_PER_USER;
    process.env.FROSH_MAX_ACTIVE_MISSIONS_PER_USER = "2";
    try {
      expect(await store.create(newMission())).not.toBeNull();
      expect(await store.create(newMission())).not.toBeNull();
      expect(await store.create(newMission())).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.FROSH_MAX_ACTIVE_MISSIONS_PER_USER;
      else process.env.FROSH_MAX_ACTIVE_MISSIONS_PER_USER = previous;
    }
  });

  test("missions are listed highest priority first", async () => {
    const store = new InMemoryMissionStore();
    await store.create(newMission({ goal: "low one", priority: "low" }));
    await store.create(newMission({ goal: "high one", priority: "high" }));
    await store.create(newMission({ goal: "normal one", priority: "normal" }));

    const listed = await store.list(USER);
    expect(listed.map((mission) => mission.priority)).toEqual(["high", "normal", "low"]);
  });
});
