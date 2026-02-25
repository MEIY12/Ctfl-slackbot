import { NextRequest, NextResponse } from "next/server";
import Redis from "ioredis";
import { randomBytes } from "crypto";
import {
  generatePKCE,
  getClientId,
  getRedirectUri,
  storeOAuthState,
  MCP_AUTHORIZE_URL,
} from "@/lib/auth";

export async function GET(req: NextRequest) {
  const redis = new Redis(process.env.REDIS_URL!);

  try {
    const { codeVerifier, codeChallenge } = generatePKCE();
    const state = randomBytes(16).toString("hex");

    await storeOAuthState(redis, state, { codeVerifier });

    const clientId = getClientId();
    const redirectUri = getRedirectUri();

    const authUrl = new URL(MCP_AUTHORIZE_URL);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    // Carry the return URL through as a fragment param if provided
    const returnTo = req.nextUrl.searchParams.get("returnTo");
    if (returnTo) {
      authUrl.searchParams.set("return_to", returnTo);
    }

    return NextResponse.redirect(authUrl.toString());
  } finally {
    await redis.quit();
  }
}
