import { NextRequest } from "next/server";
import Redis from "ioredis";
import {
  getPalmataRedirectUri,
  popOAuthState,
  storePalmataToken,
  PALMATA_TOKEN_URL,
  PALMATA_RESOURCE_URL,
} from "@/lib/auth";
import { publishHomeTab } from "@/lib/slack-home";

const SUCCESS_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Palmata connected</title></head>
<body style="font-family:system-ui;text-align:center;padding:20vh 24px"><h1>✅ Palmata connected!</h1>
<p>You can close this tab and return to Slack. Contentful Bot can now use both Contentful and Palmata.</p></body></html>`;

function errorHtml(message: string): Response {
  const escaped = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return new Response(`<html><body style="font-family:system-ui;text-align:center;padding:20vh 24px">
<h1>❌ Palmata authorization failed</h1><p>${escaped}</p><p>Please try again from Slack.</p></body></html>`, {
    status: 400,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");
  if (error) return errorHtml(searchParams.get("error_description") ?? error);
  if (!code || !state) return errorHtml("Missing code or state parameter");

  const redis = new Redis(process.env.REDIS_URL!);
  try {
    const stateData = await popOAuthState(redis, state);
    if (!stateData) return errorHtml("Invalid or expired state — please try again");

    const tokenRes = await fetch(PALMATA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: getPalmataRedirectUri(),
        client_id: stateData.clientId,
        code_verifier: stateData.codeVerifier,
        resource: PALMATA_RESOURCE_URL,
      }),
    });
    if (!tokenRes.ok) return errorHtml(`Token exchange failed: ${tokenRes.status}`);

    const tokenData = await tokenRes.json();
    await storePalmataToken(redis, {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token ?? "",
      expiresAt: Date.now() + (tokenData.expires_in ?? 3600) * 1000,
      clientId: stateData.clientId,
    });
    if (stateData.slackUserId) {
      await publishHomeTab(stateData.slackUserId).catch((err) =>
        console.error("[contentful-bot] Palmata home refresh failed:", err)
      );
    }
    return new Response(SUCCESS_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } finally {
    await redis.quit();
  }
}
