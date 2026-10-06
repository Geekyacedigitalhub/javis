import { NextRequest } from "next/server";

const API_URL = process.env.FROSH_API_URL ?? "http://localhost:3001";
const WEB_TOKEN = process.env.FROSH_WEB_TOKEN ?? "";
const USER_ID = process.env.FROSH_USER_ID ?? "default-user";

async function handler(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const target = new URL(path.join("/"), API_URL + "/");
  target.search = request.nextUrl.search;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("authorization");
  headers.set("x-frosh-web-token", WEB_TOKEN);

  let body: string | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const raw = await request.text();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (path.join("/") === "v1/chat" || path.join("/") === "v1/chat/stream") {
          if (!parsed.userId) parsed.userId = USER_ID;
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
