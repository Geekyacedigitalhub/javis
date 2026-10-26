import { expect, test } from "bun:test";
import {
  fetchGoogleUpstream,
  GOOGLE_COLD_START_RETRY_DELAYS_MS,
  GOOGLE_UPSTREAM_TIMEOUT_MS,
} from "../apps/web/lib/google-upstream";

test("keeps every Google proxy request below the Render edge window", () => {
  expect(GOOGLE_UPSTREAM_TIMEOUT_MS).toBe(15_000);
  expect(GOOGLE_COLD_START_RETRY_DELAYS_MS).toEqual([1_000]);
});

test("retries a transient Render HTML gateway response while the API wakes", async () => {
  const controller = new AbortController();
  let calls = 0;
  const response = await fetchGoogleUpstream(
    new URL("https://frosh-api.onrender.com/v1/integrations/google/users/default-user"),
    { method: "GET" },
    controller.signal,
    async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("<html>Bad Gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        });
      }
      return Response.json({ configured: true, connection: null });
    },
    [0],
  );

  expect(calls).toBe(2);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ configured: true, connection: null });
});

test("does not retry a JSON API error", async () => {
  const controller = new AbortController();
  let calls = 0;
  const response = await fetchGoogleUpstream(
    new URL("https://frosh-api.onrender.com/v1/integrations/google/users/default-user"),
    { method: "GET" },
    controller.signal,
    async () => {
      calls += 1;
      return Response.json({ error: "Google integration is not configured." }, { status: 503 });
    },
    [0],
  );

  expect(calls).toBe(1);
  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({ error: "Google integration is not configured." });
});
