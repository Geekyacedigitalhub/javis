import { afterEach, describe, expect, test } from "bun:test";
import type { FroshToolCall } from "../packages/types/src/javis";
import { closeUserPreferenceStore, getUserPreferenceStore } from "../services/preferences/src/factory";
import { approvalStore, executeToolCall, listTools, resolveApproval } from "../services/tools/src";

const ALICE = "preference-tools-alice";
const BOB = "preference-tools-bob";

function call(name: string, arguments_: Record<string, unknown> = {}): FroshToolCall {
  return { id: crypto.randomUUID(), name, arguments: arguments_, status: "planned" };
}

afterEach(async () => {
  await closeUserPreferenceStore();
});

describe("authenticated FROSH preference tools", () => {
  test("reads only the authenticated user's preferences and never exposes an owner selector", async () => {
    await getUserPreferenceStore().update(ALICE, { mode: "coding", voiceLanguage: "en-NG" });
    await getUserPreferenceStore().update(BOB, { mode: "quiet", voiceLanguage: "en-US" });

    for (const name of ["read_my_preferences", "update_my_preferences"]) {
      const tool = listTools().find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      expect((tool?.parameters as { properties?: Record<string, unknown> }).properties).not.toHaveProperty("userId");
    }

    const result = await executeToolCall(call("read_my_preferences", { userId: BOB }), { userId: ALICE });
    expect(result).toMatchObject({ status: "completed", result: { preferences: { mode: "coding", voiceLanguage: "en-NG" } } });
    expect(JSON.stringify(result.result)).not.toContain(BOB);

    const anonymous = await executeToolCall(call("read_my_preferences"));
    expect(anonymous).toMatchObject({
      status: "failed",
      result: { error: "Preferences are available only in an authenticated FROSH session." },
    });
  });

  test("requires approval before changing durable future assistant behavior", async () => {
    const pending = await executeToolCall(
      call("update_my_preferences", { mode: "focus", personality: "direct", responseLength: "short", userId: BOB }),
      { userId: ALICE, runId: "preference-tools-run" },
    );
    const approvalId = (pending.result as { approvalId: string }).approvalId;
    expect((await approvalStore.get(approvalId))?.toolName).toBe("update_my_preferences");

    const resolved = await resolveApproval(approvalId, "approved", { userId: ALICE, runId: "preference-tools-run" });
    expect(resolved.result).toMatchObject({
      preferences: { mode: "focus", personality: "direct", responseLength: "short" },
    });
    expect((await getUserPreferenceStore().get(ALICE)).mode).toBe("focus");
    expect((await getUserPreferenceStore().get(BOB)).mode).toBe("normal");
  });

  test("refuses malformed changes before a dead approval is created", async () => {
    const invalidMode = await executeToolCall(call("update_my_preferences", { mode: "bypass-safety" }), { userId: ALICE });
    expect(invalidMode).toMatchObject({ status: "failed", result: { error: "mode is invalid." } });
    expect(invalidMode.result).not.toHaveProperty("approvalId");

    const invalidLanguage = await executeToolCall(call("update_my_preferences", { voiceLanguage: "en-ng" }), { userId: ALICE });
    expect(invalidLanguage).toMatchObject({ status: "failed", result: { error: "voiceLanguage must be a BCP-47 language tag." } });
    expect(invalidLanguage.result).not.toHaveProperty("approvalId");
  });
});
