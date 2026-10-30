import { describe, expect, test } from "bun:test";
import { InMemoryNoteStore } from "../services/notes/src/store";

describe("personal notes", () => {
  test("creates, normalizes, searches, pins, updates, and scopes notes", async () => {
    const store = new InMemoryNoteStore();
    const first = await store.create({
      userId: "owner", title: "Render deployment", content: "Keep the API and web service configuration together.",
      tags: ["Deploy", "deploy", "FROSH"], pinned: true, taskId: "task-1",
    });
    await store.create({ userId: "owner", title: "Research ideas", content: "Compare monitoring services.", tags: ["research"], pinned: false });
    await store.create({ userId: "other", title: "Private", content: "Other account", tags: [], pinned: true });

    expect(first.tags).toEqual(["Deploy", "FROSH"]);
    expect((await store.list("owner", { query: "API and web" })).map((note) => note.id)).toEqual([first.id]);
    expect((await store.list("owner", { tag: "DEPLOY" })).map((note) => note.id)).toEqual([first.id]);
    expect((await store.list("owner", { pinned: true })).map((note) => note.id)).toEqual([first.id]);
    expect(await store.get(first.id, "other")).toBeNull();

    const changed = await store.update(first.id, "owner", { pinned: false, taskId: undefined, tags: ["operations"] });
    expect(changed).toMatchObject({ pinned: false, tags: ["operations"] });
    expect(changed).not.toHaveProperty("taskId");
    expect(await store.delete(first.id, "other")).toBe(false);
    expect(await store.delete(first.id, "owner")).toBe(true);
  });

  test("refuses malformed note bodies rather than guessing user content", async () => {
    const store = new InMemoryNoteStore();
    await expect(store.create({ userId: "owner", title: "", content: "content", tags: [], pinned: false })).rejects.toThrow(/title/);
    await expect(store.create({ userId: "owner", title: "Title", content: "", tags: [], pinned: false })).rejects.toThrow(/content/);
    await expect(store.create({ userId: "owner", title: "Title", content: "content", tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`), pinned: false })).rejects.toThrow(/tags/);
    await expect(store.create({ userId: "owner", title: "Title", content: "content", tags: [], pinned: "yes" as never })).rejects.toThrow(/pinned/);
  });
});
