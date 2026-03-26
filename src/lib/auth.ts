import { createHash, randomBytes } from "crypto";
import Redis from "ioredis";

export const MCP_TOKEN_URL = "https://mcp.contentful.com/token";
export const MCP_AUTHORIZE_URL = "https://mcp.contentful.com/authorize";

const WORKSPACE_TOKEN_KEY = "ctfl-bot:oauth:workspace";
const OAUTH_STATE_TTL = 60 * 10; // 10 minutes
const TOKEN_TTL = 60 * 60 * 24 * 30; // 30 days

export interface StoredToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  clientId: string;
}

export class TokenExpiredError extends Error {
  constructor(message = "Stored token is no longer valid") {
    super(message);
    this.name = "TokenExpiredError";
  }
}

export function getAppUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

export function getClientId(): string {
  return `${getAppUrl()}/api/auth/contentful/client-metadata`;
}

export function getRedirectUri(): string {
  return `${getAppUrl()}/api/auth/contentful/callback`;
}

export function getConnectUrl(): string {
  return `${getAppUrl()}/connect`;
}

export function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

export async function getStoredToken(redis: Redis): Promise<StoredToken | null> {
  const raw = await redis.get(WORKSPACE_TOKEN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredToken;
  } catch {
    return null;
  }
}

export async function storeToken(
  redis: Redis,
  token: StoredToken
): Promise<void> {
  await redis.set(
    WORKSPACE_TOKEN_KEY,
    JSON.stringify(token),
    "EX",
    TOKEN_TTL
  );
}

export async function clearToken(redis: Redis): Promise<void> {
  await redis.del(WORKSPACE_TOKEN_KEY);
}

export async function storeOAuthState(
  redis: Redis,
  state: string,
  data: { codeVerifier: string; slackUserId?: string }
): Promise<void> {
  await redis.set(
    `ctfl-bot:oauth-state:${state}`,
    JSON.stringify(data),
    "EX",
    OAUTH_STATE_TTL
  );
}

export async function popOAuthState(
  redis: Redis,
  state: string
): Promise<{ codeVerifier: string; slackUserId?: string } | null> {
  const raw = await redis.get(`ctfl-bot:oauth-state:${state}`);
  if (!raw) return null;
  await redis.del(`ctfl-bot:oauth-state:${state}`);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function refreshTokenIfNeeded(
  redis: Redis,
  token: StoredToken
): Promise<StoredToken> {
  if (token.expiresAt > Date.now() + 5 * 60 * 1000) {
    return token;
  }

  const res = await fetch(MCP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
      client_id: token.clientId,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    const isInvalidClient =
      res.status === 401 &&
      (err.includes("invalid_client") || err.includes("invalid_grant"));
    if (isInvalidClient) {
      await clearToken(redis);
      throw new TokenExpiredError(
        `Contentful client is no longer valid — please reconnect via /connect`
      );
    }
    throw new Error(`Token refresh failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  const newToken: StoredToken = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? token.refreshToken,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    clientId: token.clientId,
  };

  await storeToken(redis, newToken);
  return newToken;
}
