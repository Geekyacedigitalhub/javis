import { expect, test } from "bun:test";
import { listFroshConversations, streamFroshRequest } from "../services/api/src/server";

test("an already-cancelled chat stream emits no completion and creates no durable conversation", async () => {
  const controller = new AbortController();
  const userId = `cancel-test-${crypto.randomUUID()}`;
  controller.abort();
  const events: unknown[] = [];

  await expect((async () => {
    for await (const event of streamFroshRequest({
      userId,
      message: "This must not become a completed FROSH turn.",
      signal: controller.signal,
    })) {
      events.push(event);
    }
  })()).rejects.toThrow("response was cancelled");

  expect(events).toEqual([]);
  expect(await listFroshConversations(userId)).toEqual([]);
});
