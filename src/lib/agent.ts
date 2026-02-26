import { createMCPClient } from "@ai-sdk/mcp";
import { openai } from "@ai-sdk/openai";
import { streamText, stepCountIs, type ModelMessage } from "ai";
import Redis from "ioredis";
import {
  getStoredToken,
  refreshTokenIfNeeded,
  type StoredToken,
} from "./auth";

const HISTORY_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const MAX_HISTORY_MESSAGES = 40;

function getRedis(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set");
  return new Redis(url);
}

async function loadHistory(
  redis: Redis,
  threadId: string
): Promise<ModelMessage[]> {
  const raw = await redis.get(`ctfl-bot:history:${threadId}`);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ModelMessage[];
  } catch {
    return [];
  }
}

async function saveHistory(
  redis: Redis,
  threadId: string,
  messages: ModelMessage[]
): Promise<void> {
  const trimmed = messages.slice(-MAX_HISTORY_MESSAGES);
  await redis.set(
    `ctfl-bot:history:${threadId}`,
    JSON.stringify(trimmed),
    "EX",
    HISTORY_TTL_SECONDS
  );
}

function buildSystemPrompt(): string {
  return `You are a Contentful content management AI assistant operating via Slack.

You help teams execute large-scale content campaigns by creating content that fits into the existing content types availible to the user. 

You have access to the Contentful Management API through MCP tools. On first interaction, fetch the user's content types and the tools available to you and use them to:
- Search and retrieve existing entries, assets, and content types
- Create new entries and assets
- Update existing content fields
- Any other abilities that have been granted to you by the user's MCP tools.

Guidelines:
- Always confirm what you're about to do. Keep your responses short and concise to the critical elements that need to be reviewed or confirmed by the user.
- In your responses, stay high level as you describe the content you are planning to create. Dont go field by field, just describe the content you are planning to create.
- When creating holistic campaigns, look at the existing content and understand what they typically create (how many referenced entries, how many referenced assets, etc).
- When creating multiple related entries (e.g., a full campaign), outline the plan first, then execute step by step. These campaigns will likely involve multiple entries and even referencing newly created entries within other content types.
- After executing the task, provide clear, high level overview of what was created/updated including the entry links to created entries. Structure: https://app.contentful.com/spaces/{spaceId}]/entries/{entryId}.
- Don't include the full entry in your response, just the link and high level overview.
- Keep all responses to the user as concise as possible.`;
}

export class NotConnectedError extends Error {
  constructor() {
    super("Contentful is not connected");
    this.name = "NotConnectedError";
  }
}

export async function getWorkspaceToken(): Promise<StoredToken | null> {
  const redis = getRedis();
  try {
    return await getStoredToken(redis);
  } finally {
    await redis.quit();
  }
}

export async function runAgent(
  threadId: string,
  userMessage: string
): Promise<AsyncIterable<string>> {
  const redis = getRedis();

  // Load token and history concurrently
  const [rawToken, history] = await Promise.all([
    getStoredToken(redis),
    loadHistory(redis, threadId),
  ]);

  if (!rawToken) {
    await redis.quit();
    throw new NotConnectedError();
  }

  // Refresh the token if it's close to expiry
  const token = await refreshTokenIfNeeded(redis, rawToken);

  const updatedHistory: ModelMessage[] = [
    ...history,
    { role: "user", content: userMessage },
  ];

  const mcpClient = await createMCPClient({
    transport: {
      type: "http",
      url: "https://mcp.contentful.com/mcp",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
      },
    },
  });

  const tools = await mcpClient.tools();

  const result = streamText({
    model: openai("gpt-5"),
    system: buildSystemPrompt(),
    messages: updatedHistory,
    tools,
    stopWhen: stepCountIs(20),
    onFinish: async ({ response }) => {
      const newMessages = response.messages as ModelMessage[];
      await saveHistory(redis, threadId, [...updatedHistory, ...newMessages]);
      await mcpClient.close();
      await redis.quit();
    },
  });

  return result.textStream;
}
