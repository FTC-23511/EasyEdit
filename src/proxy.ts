import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

// A quick first filter on cookie presence only. Pages and API routes still call requireUser/requireUserApi.
export function proxy(request: NextRequest) {
  if (getSessionCookie(request)) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: [
    "/((?!login(?:/|$)|api/auth(?:/|$)|api/mcp(?:/|$)|\\.well-known(?:/|$)|_next/|.*\\.[^/]*$).*)",
  ],
};
