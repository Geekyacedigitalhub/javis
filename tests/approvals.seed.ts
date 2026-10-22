/**
 * Preload for tests/approvals.test.ts.
 *
 * Bun runs this before `services/api/src/http.ts` in the *same* process, so the
 * `approvalStore` singleton it writes to is the one the router reads from. That
 * is the only way to exercise the approve/reject happy path: the offline
 * DevelopmentProvider never emits tool calls, so nothing would otherwise create
 * an approval during a test run.
 *
 * Deliberately no assertions here -- the test reads this state back over HTTP.
 */
import { approvalStore } from "../services/tools/src";

const seed = [
  {
    toolName: "delete_memory",
    arguments: { memoryId: "memory-alpha" },
    reason: "FROSH requested the delete_memory action.",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  },
  {
    toolName: "workspace_validate",
    arguments: { command: "bun test" },
    reason: "FROSH requested the workspace_validate action.",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  },
  {
    // Already past its deadline: listing must report it as expired, not pending.
    toolName: "delete_memory",
    arguments: { memoryId: "memory-beta" },
    reason: "FROSH requested the delete_memory action.",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  },
];

for (const input of seed) {
  await approvalStore.create(input);
}

console.log("[approvals preload] seeded", seed.length, "approval requests");
