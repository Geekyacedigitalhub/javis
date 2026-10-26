import { expect, test } from "bun:test";
import { PostgresGoogleIntegrationStore } from "../services/google/src/store";

test("Google PostgreSQL store cancels a queued query instead of hanging", async () => {
  let rejectQuery: (error: unknown) => void = () => undefined;
  let cancelled = false;
  const pending = new Promise<unknown[]>((_, reject) => {
    rejectQuery = reject;
  }) as Promise<unknown[]> & { cancel: () => void };
  pending.cancel = () => {
    cancelled = true;
    rejectQuery(new Error("cancelled"));
  };

  const sql = {
    unsafe: () => pending,
  };
  const store = new PostgresGoogleIntegrationStore(sql as never, 1);

  await expect(store.getConnection("default-user")).rejects.toThrow("storage query timed out");
  expect(cancelled).toBe(true);
});
