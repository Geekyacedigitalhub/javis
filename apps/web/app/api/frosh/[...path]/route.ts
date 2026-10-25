import { NextRequest } from "next/server";

const API_URL = process.env.FROSH_API_URL ?? "http://localhost:3001";
const WEB_TOKEN = process.env.FROSH_WEB_TOKEN ?? "";
const USER_ID = process.env.FROSH_USER_ID ?? "default-user";

async function handler(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const relativePath = path.join("/");
  const userScopedMatch = relativePath.match(/^(v1\/(?:memory|conversations|tasks|briefing|automations|missions|approvals|agent-runs)\/users\/)([^/]+)(.*)$/);
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

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body,
    cache: "no-store",
  });

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
