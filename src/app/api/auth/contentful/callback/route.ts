import { NextRequest } from "next/server";
import Redis from "ioredis";
import {
  getRedirectUri,
  popOAuthState,
  storeToken,
  MCP_TOKEN_URL,
  MCP_RESOURCE_URL,
} from "@/lib/auth";
import { publishHomeTab } from "@/lib/slack-home";

const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Connected — Contentful Bot</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f8fafc;
      display: flex;
      min-height: 100vh;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 48px;
      max-width: 440px;
      width: 100%;
      text-align: center;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.06);
    }
    .icon {
      width: 56px; height: 56px;
      background: #dcfce7;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 24px;
      font-size: 28px;
    }
    h1 { font-size: 20px; font-weight: 600; color: #0f172a; margin-bottom: 10px; }
    p { font-size: 15px; color: #64748b; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>Contentful connected!</h1>
    <p>You can close this tab and return to Slack. The bot is ready — just @mention it to get started.</p>
  </div>
</body>
</html>`;

const ERROR_HTML = (message: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Error — Contentful Bot</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f8fafc;
      display: flex; min-height: 100vh;
      align-items: center; justify-content: center;
    }
    .card {
      background: white; border-radius: 16px; padding: 48px;
      max-width: 440px; width: 100%; text-align: center;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.06);
    }
    .icon { width: 56px; height: 56px; background: #fee2e2; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 24px; font-size: 28px; }
    h1 { font-size: 20px; font-weight: 600; color: #0f172a; margin-bottom: 10px; }
    p { font-size: 15px; color: #64748b; line-height: 1.6; }
    code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">❌</div>
    <h1>Authorization failed</h1>
    <p><code>${escapeHtml(message)}</code></p>
    <p style="margin-top:12px">Please try again by clicking the link in Slack.</p>
  </div>
</body>
</html>`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function html(content: string, status = 200) {
  return new Response(content, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");

  if (error) {
    return html(ERROR_HTML(errorDescription ?? error), 400);
  }

  if (!code || !state) {
    return html(ERROR_HTML("Missing code or state parameter"), 400);
  }

  const redis = new Redis(process.env.REDIS_URL!);

  try {
    const stateData = await popOAuthState(redis, state);
    if (!stateData) {
      return html(ERROR_HTML("Invalid or expired state — please try again"), 400);
    }

    const { codeVerifier, clientId } = stateData;
    const redirectUri = getRedirectUri();

    const tokenRes = await fetch(MCP_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: codeVerifier,
        resource: MCP_RESOURCE_URL,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error("[contentful-bot] token exchange failed:", err);
      return html(ERROR_HTML(`Token exchange failed: ${tokenRes.status}`), 500);
    }

    const tokenData = await tokenRes.json();

    await storeToken(redis, {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token ?? "",
      expiresAt: Date.now() + (tokenData.expires_in ?? 3600) * 1000,
      clientId,
    });

    console.log("[contentful-bot] OAuth complete — token stored for workspace");

    // Refresh the home tab for the user who initiated the flow (if we know who they are)
    const slackUserId = stateData.slackUserId;
    if (slackUserId) {
      await publishHomeTab(slackUserId).catch((e) =>
        console.error("[contentful-bot] home tab refresh after connect failed:", e)
      );
    }

    return html(SUCCESS_HTML);
  } finally {
    await redis.quit();
  }
}
