import { describe, expect, test } from "bun:test";
import { InMemoryUserPreferenceStore } from "../services/preferences/src/store";

describe("user preferences", () => {
  test("starts with safe defaults and persists a validated update", async () => {
    const store = new InMemoryUserPreferenceStore();
    const defaults = await store.get("alex");
    expect(defaults.mode).toBe("normal");
    expect(defaults.autonomyLevel).toBe("confirm");

    const updated = await store.update("alex", {
      mode: "research",
      personality: "direct",
      responseLength: "detailed",
      autonomyLevel: "safe",
      voiceLanguage: "en-NG",
    });
    expect(updated.mode).toBe("research");
    expect(updated.autonomyLevel).toBe("safe");
    expect((await store.get("alex")).personality).toBe("direct");
  });

  test("refuses a malformed preference", async () => {
    const store = new InMemoryUserPreferenceStore();
    await expect(store.update("alex", { mode: "anything" as never })).rejects.toThrow("Invalid FROSH mode");
  });
});
