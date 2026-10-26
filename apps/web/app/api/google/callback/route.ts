import { NextRequest, NextResponse } from "next/server";

const API_URL = process.env.FROSH_API_URL ?? "http://localhost:3001";
const WEB_TOKEN = process.env.FROSH_WEB_TOKEN ?? "";

function applicationOrigin(request: NextRequest): string {
  const configured = process.env.FROSH_PUBLIC_APP_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if ((url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost")) && !url.username && !url.password) {
        return url.origin;
      }
    } catch {
      // Fall back to Next's request origin only for local development.
    }
  }
  return request.nextUrl.origin;
}

/**
 * Google redirects a browser here. The code and state never enter client-side
 * JavaScript: this server route forwards them to the authenticated FROSH API,
 * which validates and consumes the one-time PKCE state before exchanging code.
 */
export async function GET(request: NextRequest) {
  const redirect = new URL("/integrations", applicationOrigin(request));
  const providerError = request.nextUrl.searchParams.get("error");
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");

  if (providerError || !code || !state) {
    redirect.searchParams.set("google", "cancelled");
    return NextResponse.redirect(redirect);
  }

  try {
    const target = new URL("/v1/integrations/google/callback", API_URL);
    const response = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-frosh-web-token": WEB_TOKEN,
      },
      body: JSON.stringify({ code, state }),
      cache: "no-store",
    });
    redirect.searchParams.set("google", response.ok ? "connected" : "error");
  } catch {
    redirect.searchParams.set("google", "error");
  }

  return NextResponse.redirect(redirect);
}
