import { NextRequest, NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  const configuredToken = process.env.FROSH_WEB_TOKEN?.trim();
  if (!configuredToken) {
    return new NextResponse("FROSH web authentication is not configured.", { status: 503 });
  }

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Basic ")) {
    return new NextResponse("Authentication required.", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="FROSH Control Center", charset="UTF-8"',
        "Cache-Control": "no-store",
      },
    });
  }

  let credentials = "";
  try {
    credentials = atob(authorization.slice(6));
  } catch {
    credentials = "";
  }

  const separator = credentials.indexOf(":");
  const password = separator >= 0 ? credentials.slice(separator + 1) : "";
  if (password !== configuredToken) {
    return new NextResponse("Authentication failed.", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="FROSH Control Center", charset="UTF-8"',
        "Cache-Control": "no-store",
      },
    });
  }

  const response = NextResponse.next();
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
