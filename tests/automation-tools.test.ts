import { afterEach, describe, expect, test } from "bun:test";
import type { FroshToolCall } from "../packages/types/src/javis";
import { closeAutomationStore, getAutomationStore } from "../services/automation/src";
import { approvalStore, executeToolCall, listTools, resolveApproval } from "../services/tools/src";

const ALICE = "automation-tools-alice";
const BOB = "automation-tools-bob";

function call(name: string, arguments_: Record<string, unknown> = {}): FroshToolCall {
  return { id: crypto.randomUUID(), name, arguments: arguments_, status: "planned" };
}

function onceSoon() {
  return { type: "once" as const, runAt: new Date(Date.now() + 60 * 60_000).toISOString() };
}

afterEach(async () => {
  await closeAutomationStore();
});

describe("authenticated personal-automation tools", () => {
  test("list and read only the server-authenticated owner's automations with bounded prompts", async () => {
    const store = getAutomationStore();
    const alice = await store.create({
      userId: ALICE,
      name: "Alice automation",
      prompt: "a".repeat(3_500),
      schedule: { type: "interval", minutes: 60 },
      status: "active",
      nextRunAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    const bob = await store.create({
      userId: BOB,
      name: "Bob automation",
      prompt: "Private prompt",
      schedule: { type: "interval", minutes: 60 },
      status: "active",
      nextRunAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    if (!alice || !bob) throw new Error("Expected automation store to accept test fixtures");

    for (const name of ["list_my_automations", "read_my_automation", "create_my_automation", "update_my_automation", "delete_my_automation"]) {
      const tool = listTools().find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      expect((tool?.parameters as { properties?: Record<string, unknown> }).properties).not.toHaveProperty("userId");
    }

    const listed = await executeToolCall(call("list_my_automations", { userId: BOB, limit: 20 }), { userId: ALICE });
    expect(listed).toMatchObject({ status: "completed", result: { automations: [expect.objectContaining({ id: alice.id, promptTruncated: true })] } });
    expect(JSON.stringify(listed.result)).not.toContain(bob.id);

    const read = await executeToolCall(call("read_my_automation", { automationId: alice.id }), { userId: ALICE });
    const automation = (read.result as { automation: { prompt: string; promptTruncated: boolean } }).automation;
    expect(automation.prompt).toHaveLength(3_000);
    expect(automation.promptTruncated).toBe(true);

    const crossOwner = await executeToolCall(call("read_my_automation", { automationId: bob.id }), { userId: ALICE });
    expect(crossOwner).toMatchObject({ status: "completed", result: { automation: null } });

    const anonymous = await executeToolCall(call("list_my_automations"));
    expect(anonymous).toMatchObject({
      status: "failed",
      result: { error: "Automations are available only in an authenticated FROSH session." },
    });
  });

  test("approval gates future automation creation, updates, and deletion", async () => {
    const createPending = await executeToolCall(
      call("create_my_automation", { name: "Daily review", prompt: "Summarize my open tasks.", schedule: onceSoon(), userId: BOB }),
      { userId: ALICE, runId: "automation-tools-run" },
    );
    const createId = (createPending.result as { approvalId: string }).approvalId;
    expect((await approvalStore.get(createId))?.toolName).toBe("create_my_automation");

    const created = await resolveApproval(createId, "approved", { userId: ALICE, runId: "automation-tools-run" });
    const automation = (created.result as { automation: { id: string; status: string; nextRunAt?: string } }).automation;
    expect(automation.status).toBe("active");
    expect(typeof automation.nextRunAt).toBe("string");
    expect(await getAutomationStore().get(automation.id, BOB)).toBeNull();

    const updatePending = await executeToolCall(
      call("update_my_automation", { automationId: automation.id, status: "paused", prompt: "Only report task counts." }),
      { userId: ALICE },
    );
    const updated = await resolveApproval((updatePending.result as { approvalId: string }).approvalId, "approved", { userId: ALICE });
    expect(updated.result).toMatchObject({ automation: { status: "paused", prompt: "Only report task counts." } });

    const resumePending = await executeToolCall(call("update_my_automation", { automationId: automation.id, status: "active" }), { userId: ALICE });
    const resumed = await resolveApproval((resumePending.result as { approvalId: string }).approvalId, "approved", { userId: ALICE });
    expect(resumed.result).toMatchObject({ automation: { status: "active" } });
    expect(Date.parse((resumed.result as { automation: { nextRunAt: string } }).automation.nextRunAt)).toBeGreaterThan(Date.now());

    const deletePending = await executeToolCall(call("delete_my_automation", { automationId: automation.id }), { userId: ALICE });
    const deleted = await resolveApproval((deletePending.result as { approvalId: string }).approvalId, "approved", { userId: ALICE });
    expect(deleted.result).toMatchObject({ deleted: true });
    expect(await getAutomationStore().get(automation.id, ALICE)).toBeNull();
  });

  test("refuses invalid schedules before it creates a dead approval", async () => {
    const malformed = await executeToolCall(
      call("create_my_automation", { name: "Too frequent", prompt: "Do work", schedule: { type: "interval", minutes: 5 } }),
      { userId: ALICE },
    );
    expect(malformed).toMatchObject({ status: "failed", result: { error: "schedule is invalid." } });
    expect(malformed.result).not.toHaveProperty("approvalId");

    const extraScheduleField = await executeToolCall(
      call("create_my_automation", { name: "Unexpected schedule", prompt: "Do work", schedule: { type: "interval", minutes: 60, extra: "no" } }),
      { userId: ALICE },
    );
    expect(extraScheduleField).toMatchObject({ status: "failed", result: { error: "schedule is invalid." } });
    expect(extraScheduleField.result).not.toHaveProperty("approvalId");

    const past = await executeToolCall(
      call("create_my_automation", { name: "Past job", prompt: "Do work", schedule: { type: "once", runAt: new Date(Date.now() - 60_000).toISOString() } }),
      { userId: ALICE },
    );
    expect(past).toMatchObject({ status: "failed", result: { error: "A one-time automation must be scheduled in the future." } });
  });

  test("does not mutate another owner's automation after an approved request", async () => {
    const automation = await getAutomationStore().create({
      userId: ALICE,
      name: "Alice only",
      prompt: "Private future work",
      schedule: { type: "interval", minutes: 60 },
      status: "active",
      nextRunAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    if (!automation) throw new Error("Expected automation fixture");

    const pending = await executeToolCall(call("update_my_automation", { automationId: automation.id, status: "paused" }), { userId: BOB });
    const result = await resolveApproval((pending.result as { approvalId: string }).approvalId, "approved", { userId: BOB });
    expect(result.result).toMatchObject({ automation: null });
    expect(await getAutomationStore().get(automation.id, ALICE)).toMatchObject({ status: "active" });
  });
});
