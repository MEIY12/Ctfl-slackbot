import { createHash, randomBytes } from "crypto";
import Redis from "ioredis";

export const MCP_TOKEN_URL = "https://mcp.contentful.com/token";
export const MCP_AUTHORIZE_URL = "https://mcp.contentful.com/authorize";
export const MCP_RESOURCE_URL = "https://mcp.contentful.com/mcp";
const MCP_REGISTER_URL = "https://mcp.contentful.com/register";
export const PALMATA_TOKEN_URL = "https://mcp.palmata.ai/token";
export const PALMATA_AUTHORIZE_URL = "https://mcp.palmata.ai/authorize";
export const PALMATA_RESOURCE_URL = "https://mcp.palmata.ai";
export const PALMATA_SCOPE = "read";
const PALMATA_REGISTER_URL = "https://mcp.palmata.ai/register";

const WORKSPACE_TOKEN_KEY = "ctfl-bot:oauth:workspace";
const REGISTERED_CLIENT_KEY = "ctfl-bot:oauth:registered-client";
const PALMATA_TOKEN_KEY = "ctfl-bot:oauth:palmata";
const PALMATA_REGISTERED_CLIENT_KEY = "ctfl-bot:oauth:palmata-registered-client";
const OAUTH_STATE_TTL = 60 * 10; // 10 minutes
const TOKEN_TTL = 60 * 60 * 24 * 30; // 30 days

export interface StoredToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  clientId: string;
}

export type PalmataToken = StoredToken;

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

interface RegisteredClient {
  clientId: string;
  registeredAt: number;
}

async function registerClient(redis: Redis): Promise<RegisteredClient> {
  const res = await fetch(MCP_REGISTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Contentful Slack Bot",
      redirect_uris: [getRedirectUri()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Dynamic client registration failed (${res.status}): ${err}`);
  }
  const data = await res.json();
  const registered: RegisteredClient = {
    clientId: data.client_id,
    registeredAt: Date.now(),
  };
  await redis.set(REGISTERED_CLIENT_KEY, JSON.stringify(registered));
  return registered;
}

export async function getOrRegisterClient(redis: Redis): Promise<string> {
  const raw = await redis.get(REGISTERED_CLIENT_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as RegisteredClient;
      if (parsed.clientId) return parsed.clientId;
    } catch {
      // fall through to re-register
    }
  }
  const registered = await registerClient(redis);
  return registered.clientId;
}

export async function clearRegisteredClient(redis: Redis): Promise<void> {
  await redis.del(REGISTERED_CLIENT_KEY);
}

export function getRedirectUri(): string {
  return `${getAppUrl()}/api/auth/contentful/callback`;
}

export function getPalmataRedirectUri(): string {
  return `${getAppUrl()}/api/auth/palmata/callback`;
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

async function registerPalmataClient(redis: Redis): Promise<RegisteredClient> {
  const res = await fetch(PALMATA_REGISTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Contentful Slack Bot",
      redirect_uris: [getPalmataRedirectUri()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: PALMATA_SCOPE,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Palmata client registration failed (${res.status}): ${err}`);
  }
  const data = await res.json();
  const registered: RegisteredClient = {
    clientId: data.client_id,
    registeredAt: Date.now(),
  };
  await redis.set(PALMATA_REGISTERED_CLIENT_KEY, JSON.stringify(registered));
  return registered;
}

export async function getOrRegisterPalmataClient(redis: Redis): Promise<string> {
  const raw = await redis.get(PALMATA_REGISTERED_CLIENT_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as RegisteredClient;
      if (parsed.clientId) return parsed.clientId;
    } catch {
      // fall through to re-register
    }
  }
  return (await registerPalmataClient(redis)).clientId;
}

export async function getPalmataToken(redis: Redis): Promise<PalmataToken | null> {
  const raw = await redis.get(PALMATA_TOKEN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PalmataToken;
  } catch {
    return null;
  }
}

export async function storePalmataToken(redis: Redis, token: PalmataToken): Promise<void> {
  await redis.set(PALMATA_TOKEN_KEY, JSON.stringify(token), "EX", TOKEN_TTL);
}

export async function clearPalmataToken(redis: Redis): Promise<void> {
  await redis.del(PALMATA_TOKEN_KEY);
}

export async function clearPalmataClient(redis: Redis): Promise<void> {
  await redis.del(PALMATA_REGISTERED_CLIENT_KEY);
}

export async function refreshPalmataTokenIfNeeded(
  redis: Redis,
  token: PalmataToken
): Promise<PalmataToken> {
  if (token.expiresAt > Date.now() + 5 * 60 * 1000) return token;

  const res = await fetch(PALMATA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
      client_id: token.clientId,
      resource: PALMATA_RESOURCE_URL,
      scope: PALMATA_SCOPE,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    if (res.status === 401 && (err.includes("invalid_client") || err.includes("invalid_grant"))) {
      await clearPalmataToken(redis);
      await clearPalmataClient(redis);
      throw new TokenExpiredError("Palmata authorization expired — please reconnect via /connect");
    }
    throw new Error(`Palmata token refresh failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  const newToken: PalmataToken = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? token.refreshToken,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    clientId: token.clientId,
  };
  await storePalmataToken(redis, newToken);
  return newToken;
}

export async function storeOAuthState(
  redis: Redis,
  state: string,
  data: { codeVerifier: string; clientId: string; slackUserId?: string }
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
): Promise<{ codeVerifier: string; clientId: string; slackUserId?: string } | null> {
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
      resource: MCP_RESOURCE_URL,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    const isInvalidClient =
      res.status === 401 &&
      (err.includes("invalid_client") || err.includes("invalid_grant"));
    if (isInvalidClient) {
      await clearToken(redis);
      await clearRegisteredClient(redis);
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
