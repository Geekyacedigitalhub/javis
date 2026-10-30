import { afterEach, describe, expect, test } from "bun:test";
import type { FroshToolCall } from "../packages/types/src/javis";
import { closeMonitorStore, getMonitorStore } from "../services/monitoring/src";
import { approvalStore, executeToolCall, listTools, resolveApproval } from "../services/tools/src";

const ALICE = "monitor-tools-alice";
const BOB = "monitor-tools-bob";
const originalFetch = globalThis.fetch;

function call(name: string, arguments_: Record<string, unknown> = {}): FroshToolCall {
  return { id: crypto.randomUUID(), name, arguments: arguments_, status: "planned" };
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await closeMonitorStore();
});

describe("authenticated personal-monitor tools", () => {
  test("list and read only the server-authenticated owner's monitors", async () => {
    const store = getMonitorStore();
    const alice = await store.create({ userId: ALICE, name: "Alice API", url: "https://8.8.8.8/alice", intervalMinutes: 5 });
    const bob = await store.create({ userId: BOB, name: "Bob API", url: "https://8.8.4.4/bob", intervalMinutes: 5 });

    for (const name of [
      "list_my_monitors", "read_my_monitor", "list_my_monitor_events", "create_my_monitor",
      "update_my_monitor", "check_my_monitor_now", "delete_my_monitor",
    ]) {
      const tool = listTools().find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      expect((tool?.parameters as { properties?: Record<string, unknown> }).properties).not.toHaveProperty("userId");
    }

    const listed = await executeToolCall(call("list_my_monitors", { userId: BOB, limit: 20 }), { userId: ALICE });
    expect(listed).toMatchObject({ status: "completed", result: { monitors: [expect.objectContaining({ id: alice.id, name: "Alice API" })] } });
    expect(JSON.stringify(listed.result)).not.toContain(bob.id);

    const crossOwner = await executeToolCall(call("read_my_monitor", { monitorId: bob.id }), { userId: ALICE });
    expect(crossOwner).toMatchObject({ status: "completed", result: { monitor: null } });

    const anonymous = await executeToolCall(call("list_my_monitors"));
    expect(anonymous).toMatchObject({
      status: "failed",
      result: { error: "Monitors are available only in an authenticated FROSH session." },
    });
  });

  test("approval gates monitor creation, changes, immediate probes, and deletion", async () => {
    const pendingCreate = await executeToolCall(
      call("create_my_monitor", { name: "Release API", url: "https://8.8.8.8/health", intervalMinutes: 5, userId: BOB }),
      { userId: ALICE, runId: "monitor-tools-run" },
    );
    const createId = (pendingCreate.result as { approvalId: string }).approvalId;
    expect((await approvalStore.get(createId))?.toolName).toBe("create_my_monitor");

    const created = await resolveApproval(createId, "approved", { userId: ALICE, runId: "monitor-tools-run" });
    const monitor = (created.result as { monitor: { id: string; status: string; health: string } }).monitor;
    expect(monitor).toMatchObject({ status: "active", health: "unknown" });
    expect(await getMonitorStore().get(monitor.id, BOB)).toBeNull();

    const updatePending = await executeToolCall(
      call("update_my_monitor", { monitorId: monitor.id, status: "paused" }),
      { userId: ALICE },
    );
    const updated = await resolveApproval((updatePending.result as { approvalId: string }).approvalId, "approved", { userId: ALICE });
    expect(updated.result).toMatchObject({ monitor: { status: "paused" } });

    const resumePending = await executeToolCall(
      call("update_my_monitor", { monitorId: monitor.id, status: "active", intervalMinutes: 10 }),
      { userId: ALICE },
    );
    await resolveApproval((resumePending.result as { approvalId: string }).approvalId, "approved", { userId: ALICE });

    globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const checkPending = await executeToolCall(call("check_my_monitor_now", { monitorId: monitor.id }), { userId: ALICE });
    const checked = await resolveApproval((checkPending.result as { approvalId: string }).approvalId, "approved", { userId: ALICE });
    expect(checked.result).toMatchObject({ monitor: { health: "healthy", lastStatusCode: 204 } });

    const events = await executeToolCall(call("list_my_monitor_events", { monitorId: monitor.id }), { userId: ALICE });
    expect(events.result).toMatchObject({ events: [expect.objectContaining({ type: "healthy" })] });

    const deletePending = await executeToolCall(call("delete_my_monitor", { monitorId: monitor.id }), { userId: ALICE });
    const deleted = await resolveApproval((deletePending.result as { approvalId: string }).approvalId, "approved", { userId: ALICE });
    expect(deleted.result).toMatchObject({ deleted: true });
    expect(await getMonitorStore().get(monitor.id, ALICE)).toBeNull();
  });

  test("refuses unsafe monitor targets before creating an approval", async () => {
    const privateTarget = await executeToolCall(
      call("create_my_monitor", { name: "Internal service", url: "https://127.0.0.1/private", intervalMinutes: 5 }),
      { userId: ALICE },
    );
    expect(privateTarget).toMatchObject({ status: "failed", result: { error: expect.stringMatching(/Private|Local/) } });
    expect(privateTarget.result).not.toHaveProperty("approvalId");

    const missingPatch = await executeToolCall(call("update_my_monitor", { monitorId: "monitor-1" }), { userId: ALICE });
    expect(missingPatch).toMatchObject({ status: "failed", result: { error: "Provide at least one monitor field to update." } });
  });

  test("does not mutate another owner's monitor after an approved request", async () => {
    const monitor = await getMonitorStore().create({ userId: ALICE, name: "Alice only", url: "https://8.8.8.8/health", intervalMinutes: 5 });
    const pending = await executeToolCall(call("update_my_monitor", { monitorId: monitor.id, status: "paused" }), { userId: BOB });
    const result = await resolveApproval((pending.result as { approvalId: string }).approvalId, "approved", { userId: BOB });

    expect(result.result).toMatchObject({ monitor: null });
    expect(await getMonitorStore().get(monitor.id, ALICE)).toMatchObject({ status: "active" });
  });
});
