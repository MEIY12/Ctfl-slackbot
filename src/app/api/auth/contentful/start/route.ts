import { NextRequest, NextResponse } from "next/server";
import Redis from "ioredis";
import { randomBytes } from "crypto";
import {
  generatePKCE,
  getOrRegisterClient,
  getRedirectUri,
  storeOAuthState,
  MCP_AUTHORIZE_URL,
  MCP_RESOURCE_URL,
} from "@/lib/auth";

export async function GET(req: NextRequest) {
  const redis = new Redis(process.env.REDIS_URL!);

  try {
    const { codeVerifier, codeChallenge } = generatePKCE();
    const state = randomBytes(16).toString("hex");
    const slackUserId = req.nextUrl.searchParams.get("uid") ?? undefined;

    const clientId = await getOrRegisterClient(redis);
    const redirectUri = getRedirectUri();

    await storeOAuthState(redis, state, { codeVerifier, clientId, slackUserId });

    const authUrl = new URL(MCP_AUTHORIZE_URL);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("resource", MCP_RESOURCE_URL);

    return NextResponse.redirect(authUrl.toString());
  } finally {
    await redis.quit();
  }
}
