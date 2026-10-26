import { describe, expect, test } from "bun:test";
import { InMemoryTaskStore } from "../services/productivity/src/store";

describe("personal task store", () => {
  test("creates, orders, completes, and scopes tasks", async () => {
    const store = new InMemoryTaskStore();
    const later = await store.create({
      userId: "alex",
      title: "Later task",
      dueAt: "2030-01-02T10:00:00.000Z",
      status: "open",
      priority: "normal",
    });
    const soon = await store.create({
      userId: "alex",
      title: "Soon task",
      dueAt: "2030-01-01T10:00:00.000Z",
      status: "open",
      priority: "high",
    });
    await store.create({ userId: "other", title: "Private", status: "open", priority: "normal" });

    expect((await store.list("alex")).map((task) => task.id)).toEqual([soon.id, later.id]);
    expect(await store.get(soon.id, "other")).toBeNull();

    const completed = await store.update(soon.id, "alex", { status: "completed" });
    expect(typeof completed?.completedAt).toBe("string");
    expect((await store.list("alex"))[0].id).toBe(later.id);
    expect(await store.delete(later.id, "alex")).toBe(true);
    expect(await store.get(later.id, "alex")).toBeNull();
  });

  test("rejects an unsafe task payload", async () => {
    const store = new InMemoryTaskStore();
    await expect(store.create({
      userId: "alex",
      title: "\u0000unsafe",
      status: "open",
      priority: "normal",
    })).rejects.toThrow("title is invalid");
  });
});
