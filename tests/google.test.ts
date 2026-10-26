import { describe, expect, test } from "bun:test";
import { InMemoryGoogleIntegrationStore } from "../services/google/src/store";
import { GoogleIntegrationService } from "../services/google/src/service";

const NOW = Date.parse("2030-01-02T03:04:05.000Z");
const KEY = Buffer.alloc(32, 7).toString("base64");
const environment = {
  GOOGLE_CLIENT_ID: "frosh-test.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "not-a-real-secret",
  FROSH_GOOGLE_REDIRECT_URI: "http://localhost:3000/api/google/callback",
  FROSH_GOOGLE_TOKEN_ENCRYPTION_KEY: KEY,
};

describe("Google OAuth integration", () => {
  test("uses a one-time PKCE state and persists encrypted tokens only", async () => {
    const store = new InMemoryGoogleIntegrationStore();
    let exchanged = false;
    const service = new GoogleIntegrationService(store, {
      environment,
      now: () => NOW,
      fetcher: async (_input, init) => {
        exchanged = true;
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("grant_type")).toBe("authorization_code");
        expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{40,}$/);
        return new Response(JSON.stringify({
          access_token: "access-token-for-test",
          refresh_token: "refresh-token-for-test",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.readonly",
        }), { headers: { "content-type": "application/json" } });
      },
    });

    const start = await service.beginAuthorization("alex");
    const authorization = new URL(start.authorizationUrl);
    expect(authorization.origin).toBe("https://accounts.google.com");
    expect(authorization.searchParams.get("redirect_uri")).toBe(environment.FROSH_GOOGLE_REDIRECT_URI);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("state")).toBeTruthy();

    const connection = await service.completeAuthorization({
      code: "one-time-google-code",
      state: authorization.searchParams.get("state")!,
    });
    expect(exchanged).toBe(true);
    expect(connection.status).toBe("connected");
    expect(connection.scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect((connection as unknown as Record<string, unknown>).encryptedTokenSet).toBeUndefined();

    const raw = await store.getConnection("alex");
    expect(raw?.encryptedTokenSet).not.toContain("refresh-token-for-test");
    expect(raw?.encryptedTokenSet).not.toContain("access-token-for-test");

    await expect(service.completeAuthorization({
      code: "replayed-code",
      state: authorization.searchParams.get("state")!,
    })).rejects.toThrow("already used");
  });

  test("keeps the integration unavailable until all server-side secrets exist", async () => {
    const service = new GoogleIntegrationService(new InMemoryGoogleIntegrationStore(), {
      environment: { FROSH_GOOGLE_REDIRECT_URI: "http://localhost:3000/api/google/callback" },
      now: () => NOW,
    });
    expect((await service.connectionStatus("alex")).configured).toBe(false);
    await expect(service.beginAuthorization("alex")).rejects.toThrow("GOOGLE_CLIENT_ID is required");
  });

  test("returns only metadata for Gmail reads and requires an approval-gated tool for writes", async () => {
    const store = new InMemoryGoogleIntegrationStore();
    let requestCount = 0;
    const service = new GoogleIntegrationService(store, {
      environment,
      now: () => NOW,
      fetcher: async (input) => {
        requestCount += 1;
        const url = String(input);
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({
            access_token: "access-token-for-test",
            refresh_token: "refresh-token-for-test",
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.readonly",
          }));
        }
        if (url.includes("/messages?") || url.includes("/messages&")) {
          return new Response(JSON.stringify({ messages: [{ id: "m1" }] }));
        }
        if (url.includes("/messages/m1")) {
          return new Response(JSON.stringify({
            id: "m1", threadId: "t1", snippet: "A short unread message.",
            payload: { headers: [{ name: "From", value: "Ada <ada@example.com>" }, { name: "Subject", value: "Hello" }] },
          }));
        }
        throw new Error("Unexpected request " + url);
      },
    });
    const start = await service.beginAuthorization("alex");
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;
    await service.completeAuthorization({ code: "one-time-google-code", state });
    const messages = await service.listUnreadGmail("alex", 1);
    expect(requestCount).toBe(3);
    expect(messages).toEqual([{ id: "m1", threadId: "t1", from: "Ada <ada@example.com>", subject: "Hello", receivedAt: undefined, snippet: "A short unread message." }]);
  });
});
