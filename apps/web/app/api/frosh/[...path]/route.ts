import { NextRequest } from "next/server";

const API_URL = process.env.FROSH_API_URL ?? "http://localhost:3001";
const WEB_TOKEN = process.env.FROSH_WEB_TOKEN ?? "";
const USER_ID = process.env.FROSH_USER_ID ?? "default-user";
const GOOGLE_UPSTREAM_TIMEOUT_MS = 20_000;

async function handler(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const relativePath = path.join("/");
  const userScopedMatch = relativePath.match(/^(v1\/(?:memory|conversations|preferences|tasks|briefing|automations|missions|approvals|agent-runs|integrations\/google)\/users\/)([^/]+)(.*)$/);
  const effectivePath = userScopedMatch
    ? userScopedMatch[1] + encodeURIComponent(USER_ID) + userScopedMatch[3]
    : relativePath;
  const target = new URL(API_URL);
  target.pathname = "/" + effectivePath.replace(/^\/+/, "");
  target.search = request.nextUrl.search;

  // This is a server-side boundary, not a transparent HTTP tunnel. Forwarding
  // connection-specific headers (especially content-length and connection)
  // after Next has consumed the request body can make an upstream server close
  // the socket. Only pass the representation headers this API actually needs.
  const headers = new Headers();
  const accept = request.headers.get("accept");
  if (accept) headers.set("accept", accept);
  headers.set("x-frosh-web-token", WEB_TOKEN);

  let body: string | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const raw = await request.text();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (path.join("/") === "v1/chat" || path.join("/") === "v1/chat/stream") {
          parsed.userId = USER_ID;
        }
        body = JSON.stringify(parsed);
        headers.set("content-type", "application/json");
      } catch {
        body = raw;
      }
    }
  }

  const controller = new AbortController();
  // The Google connection UI needs a bounded failure rather than a gateway's
  // generic HTML error. Keep long-running assistant and mission requests
  // unbounded here; they have their own lifecycle and status mechanisms.
  const isGoogleIntegrationRequest = relativePath.startsWith("v1/integrations/google/");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let upstream: Response;
  try {
    const upstreamRequest = fetch(target, {
      method: request.method,
      headers,
      body,
      cache: "no-store",
      signal: controller.signal,
    });
    upstream = isGoogleIntegrationRequest
      ? await Promise.race([
        upstreamRequest,
        new Promise<Response>((resolve) => {
          timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
            // Some runtime fetch implementations do not settle promptly after
            // aborting an upstream socket. Resolve the route ourselves so the
            // browser always receives JSON instead of a Cloudflare 502 page.
            resolve(Response.json(
              { error: "FROSH API did not respond in time. Please retry shortly." },
              { status: 504, headers: { "cache-control": "no-store" } },
            ));
          }, GOOGLE_UPSTREAM_TIMEOUT_MS);
        }),
      ])
      : await upstreamRequest;
  } catch {
    return Response.json(
      { error: timedOut ? "FROSH API did not respond in time. Please retry shortly." : "FROSH API could not be reached. Please retry shortly." },
      { status: timedOut ? 504 : 502, headers: { "cache-control": "no-store" } },
    );
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  // The Render edge can turn an upstream API failure into an HTML Cloudflare
  // page. Never forward that page to the control center for Google requests:
  // callers need a machine-readable response they can retry or display safely.
  const contentType = upstream.headers.get("content-type") ?? "";
  if (isGoogleIntegrationRequest && !contentType.toLowerCase().includes("application/json")) {
    return Response.json(
      { error: "FROSH Google integration is temporarily unavailable. Please retry shortly." },
      { status: upstream.status >= 500 ? 502 : upstream.status || 502, headers: { "cache-control": "no-store" } },
    );
  }

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("cache-control", "no-store");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
