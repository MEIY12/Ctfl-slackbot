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

// Strip tool-call/tool-result messages from history so failed MCP calls don't
// poison future turns and cause the model to stop retrying tools.
// Only text-generating assistant messages and user messages are kept.
function sanitizeHistoryMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.filter((msg) => {
    if (msg.role === "tool") return false;
    if (
      msg.role === "assistant" &&
      Array.isArray(msg.content) &&
      msg.content.length > 0 &&
      (msg.content as Array<{ type: string }>).every(
        (c) => c.type === "tool-call"
      )
    ) {
      return false;
    }
    return true;
  });
}

async function saveHistory(
  redis: Redis,
  threadId: string,
  messages: ModelMessage[]
): Promise<void> {
  const sanitized = sanitizeHistoryMessages(messages);
  const trimmed = sanitized.slice(-MAX_HISTORY_MESSAGES);
  await redis.set(
    `ctfl-bot:history:${threadId}`,
    JSON.stringify(trimmed),
    "EX",
    HISTORY_TTL_SECONDS
  );
}

function buildSystemPrompt(): string {
  return `You are a Contentful content management AI assistant operating via Slack.

You help teams execute large-scale content campaigns — including creating and updating banners, landing pages, page components, blog posts, FAQ entries, and other content types.

You have full access to the Contentful Management API through MCP tools. Use them to:
- Search and retrieve existing entries, assets, and content types
- Create new entries and assets
- Update existing content fields
- Publish and unpublish entries and assets
- Manage content types and their fields
- Work with locales and tags
- Invoke AI Actions for batch content operations

Guidelines:
- Always confirm what you're about to do for large or destructive operations before executing
- When creating multiple related entries (e.g., a full campaign), outline the plan first, then execute step by step
- Provide clear summaries of what was created/updated including entry IDs where possible
- If a content type doesn't exist yet, you can create it — but ask before doing so
- Prefer updating existing entries over creating duplicates
- Always publish content only when explicitly asked to do so`;
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
