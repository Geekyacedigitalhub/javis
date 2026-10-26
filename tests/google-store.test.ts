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

test("Google PostgreSQL store leaves an active query to the database statement timeout", async () => {
  let rejectQuery: (error: unknown) => void = () => undefined;
  let cancelled = false;
  const pending = new Promise<unknown[]>((_, reject) => {
    rejectQuery = reject;
  }) as Promise<unknown[]> & { cancel: () => void; state?: unknown };
  pending.state = { pid: 42 };
  pending.cancel = () => {
    cancelled = true;
    rejectQuery(new Error("cancelled"));
  };

  const sql = {
    unsafe: () => pending,
  };
  const store = new PostgresGoogleIntegrationStore(sql as never, 1);

  await expect(store.getConnection("default-user")).rejects.toThrow("storage query timed out");
  expect(cancelled).toBe(false);
  // Finish the simulated database-side timeout after the application response
  // has already been bounded, avoiding a dangling rejection in the test.
  rejectQuery(new Error("statement timeout"));
});

test("Google PostgreSQL store uses the established per-user preference record", async () => {
  const statements: string[] = [];
  const sql = {
    unsafe: (statement: string) => {
      statements.push(statement);
      const rows = Object.assign([], { count: 0 });
      return Object.assign(Promise.resolve(rows), { cancel: () => undefined });
    },
  };
  const store = new PostgresGoogleIntegrationStore(sql as never, 20);

  await expect(store.getConnection("default-user")).resolves.toBeNull();
  await store.createOAuthState({
    stateHash: "a".repeat(43),
    userId: "default-user",
    encryptedCodeVerifier: "encrypted-verifier",
    expiresAt: "2030-01-02T03:04:05.000Z",
  });

  expect(statements).toHaveLength(2);
  expect(statements.every((statement) => statement.includes("frosh_user_preferences"))).toBe(true);
  expect(statements.join(" ")).not.toContain("frosh_google_connections");
  expect(statements.join(" ")).not.toContain("frosh_google_oauth_states");
});
