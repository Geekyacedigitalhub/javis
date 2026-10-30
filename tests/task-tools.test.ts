import { afterEach, describe, expect, test } from "bun:test";
import type { FroshToolCall } from "../packages/types/src/javis";
import { closeTaskStore, getTaskStore } from "../services/productivity/src";
import { approvalStore, executeToolCall, listTools, resolveApproval } from "../services/tools/src";
import { buildModelInput } from "../services/ai/src/provider";

const ALICE = "task-tools-alice";
const BOB = "task-tools-bob";

function call(name: string, arguments_: Record<string, unknown> = {}): FroshToolCall {
  return { id: crypto.randomUUID(), name, arguments: arguments_, status: "planned" };
}

afterEach(async () => {
  await closeTaskStore();
});

describe("authenticated personal-task tools", () => {
  test("treats durable personal content returned by tools as untrusted reference data", () => {
    expect(buildModelInput([]).system).toContain("untrusted reference data");
  });

  test("read only server-authenticated owner data and keep task content bounded", async () => {
    const store = getTaskStore();
    const alice = await store.create({
      userId: ALICE,
      title: "Prepare launch",
      notes: "a".repeat(3_500),
      status: "in_progress",
      priority: "high",
    });
    const bob = await store.create({ userId: BOB, title: "Private plan", status: "open", priority: "normal" });

    for (const name of ["list_my_tasks", "read_my_task", "create_my_task", "update_my_task", "delete_my_task"]) {
      const tool = listTools().find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      expect((tool?.parameters as { properties?: Record<string, unknown> }).properties).not.toHaveProperty("userId");
    }

    const listed = await executeToolCall(call("list_my_tasks", { userId: BOB, limit: 20 }), { userId: ALICE });
    expect(listed.status).toBe("completed");
    expect(listed.result).toMatchObject({ tasks: [expect.objectContaining({ id: alice.id, notesTruncated: true })] });
    expect(JSON.stringify(listed.result)).not.toContain(bob.id);

    const read = await executeToolCall(call("read_my_task", { taskId: alice.id }), { userId: ALICE });
    const task = (read.result as { task: { notes: string; notesTruncated: boolean } }).task;
    expect(task.notes).toHaveLength(3_000);
    expect(task.notesTruncated).toBe(true);

    const crossOwner = await executeToolCall(call("read_my_task", { taskId: bob.id }), { userId: ALICE });
    expect(crossOwner).toMatchObject({ status: "completed", result: { task: null } });

    const anonymous = await executeToolCall(call("list_my_tasks"));
    expect(anonymous).toMatchObject({
      status: "failed",
      result: { error: "Personal tasks are available only in an authenticated FROSH session." },
    });
  });

  test("requires approval for task mutations and executes an approved mutation for its authenticated owner", async () => {
    const planned = await executeToolCall(
      call("create_my_task", { title: "Prepare release notes", priority: "high", userId: BOB }),
      { userId: ALICE, runId: "task-tools-run" },
    );
    expect(planned.status).toBe("failed");
    const approvalId = (planned.result as { approvalId: string }).approvalId;
    expect((await approvalStore.get(approvalId))?.toolName).toBe("create_my_task");

    const created = await resolveApproval(approvalId, "approved", { userId: ALICE, runId: "task-tools-run" });
    const task = (created.result as { task: { id: string; title: string; priority: string } }).task;
    expect(task).toMatchObject({ title: "Prepare release notes", priority: "high" });
    expect(await getTaskStore().get(task.id, ALICE)).toMatchObject({ title: "Prepare release notes" });
    expect(await getTaskStore().get(task.id, BOB)).toBeNull();

    const updatePending = await executeToolCall(
      call("update_my_task", { taskId: task.id, status: "completed" }),
      { userId: ALICE },
    );
    const updateId = (updatePending.result as { approvalId: string }).approvalId;
    const updated = await resolveApproval(updateId, "approved", { userId: ALICE });
    expect((updated.result as { task: { status: string; completedAt?: string } }).task).toMatchObject({ status: "completed" });
    expect(typeof (updated.result as { task: { completedAt?: string } }).task.completedAt).toBe("string");

    const deletePending = await executeToolCall(call("delete_my_task", { taskId: task.id }), { userId: ALICE });
    const deleteId = (deletePending.result as { approvalId: string }).approvalId;
    const deleted = await resolveApproval(deleteId, "approved", { userId: ALICE });
    expect(deleted.result).toMatchObject({ deleted: true });
    expect(await getTaskStore().get(task.id, ALICE)).toBeNull();
  });

  test("cannot mutate another owner's task even after an approval is resolved", async () => {
    const task = await getTaskStore().create({ userId: ALICE, title: "Alice only", status: "open", priority: "normal" });
    const pending = await executeToolCall(call("update_my_task", { taskId: task.id, status: "completed" }), { userId: BOB });
    const approvalId = (pending.result as { approvalId: string }).approvalId;

    const result = await resolveApproval(approvalId, "approved", { userId: BOB });
    expect(result.result).toMatchObject({ task: null, message: "Task not found." });
    expect(await getTaskStore().get(task.id, ALICE)).toMatchObject({ status: "open" });
  });

  test("refuses malformed mutation arguments before creating a dead approval", async () => {
    const invalid = await executeToolCall(call("create_my_task", { title: "", dueAt: "tomorrow" }), { userId: ALICE });
    expect(invalid).toMatchObject({ status: "failed", result: { error: expect.stringMatching(/title/) } });
    expect(invalid.result).not.toHaveProperty("approvalId");

    const missingPatch = await executeToolCall(call("update_my_task", { taskId: "task-1" }), { userId: ALICE });
    expect(missingPatch).toMatchObject({ status: "failed", result: { error: "Provide at least one task field to update." } });
  });
});
