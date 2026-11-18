import { NextResponse, type NextRequest } from "next/server";
import { getAppUrl, isCanonicalAppHost } from "@/lib/auth";

export function middleware(request: NextRequest) {
  const { hostname, pathname, search } = request.nextUrl;
  if (isCanonicalAppHost(hostname)) {
    return NextResponse.next();
  }

  // Preview / branch deployment hosts must not own OAuth callbacks.
  if (!hostname.endsWith(".vercel.app")) {
    return NextResponse.next();
  }

  const canonical = new URL(getAppUrl());
  const redirectUrl = new URL(`${pathname}${search}`, canonical);
  return NextResponse.redirect(redirectUrl);
}

export const config = {
  matcher: ["/connect", "/api/auth/:path*"],
};