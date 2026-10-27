import { NextRequest, NextResponse } from "next/server";

const API_URL = process.env.FROSH_API_URL ?? "http://localhost:3001";
const WEB_TOKEN = process.env.FROSH_WEB_TOKEN ?? "";

const GOOGLE_CALLBACK_CODES = new Set([
  "authorization_failed",
  "upstream_failed",
  "not_configured",
  "reconnect_required",
]);

async function callbackFailure(response: Response): Promise<{ code?: string; message?: string }> {
  try {
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
    const record = payload as Record<string, unknown>;
    const code = typeof record.code === "string" && GOOGLE_CALLBACK_CODES.has(record.code)
      ? record.code
      : undefined;
    // The API deliberately returns only user-safe GoogleIntegrationError
    // messages. Limit and normalize it before it crosses a redirect URL.
    const rawMessage = typeof record.error === "string" ? record.error : "";
    const message = rawMessage
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240) || undefined;
    return { code, message };
  } catch {
    return {};
  }
}

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
    if (response.ok) {
      redirect.searchParams.set("google", "connected");
    } else {
      const failure = await callbackFailure(response);
      console.warn("FROSH Google callback failed", response.status, failure.code ?? "unknown", failure.message ?? "(no safe message)");
      redirect.searchParams.set("google", "error");
      if (failure.code) redirect.searchParams.set("google_code", failure.code);
      if (failure.message) redirect.searchParams.set("google_message", failure.message);
    }
  } catch (error) {
    const name = error instanceof Error && error.name ? error.name : "UnknownError";
    console.warn("FROSH Google callback request failed", name);
    redirect.searchParams.set("google", "error");
    redirect.searchParams.set("google_code", "upstream_failed");
  }

  return NextResponse.redirect(redirect);
}
