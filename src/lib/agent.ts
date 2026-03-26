import { createMCPClient } from "@ai-sdk/mcp";
import { openai } from "@ai-sdk/openai";
import {
  streamText,
  stepCountIs,
  type ModelMessage,
  type UserContent,
} from "ai";
import { createHash } from "crypto";
import Redis from "ioredis";
import { getStoredToken, refreshTokenIfNeeded, TokenExpiredError, type StoredToken } from "./auth";

const HISTORY_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const MAX_HISTORY_MESSAGES = 40;
const IDEMPOTENCY_TTL_SECONDS = 60 * 10; // 10 minutes
const DEFAULT_STEP_CAP = 30;

export type FileAttachment = {
  data: Buffer;
  name?: string;
  mimeType?: string;
};

const NATIVE_FILE_MIMES = new Set(["application/pdf"]);

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function isTextMime(mime: string, filename?: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (mime === "application/json" || mime === "application/xml") return true;
  if (!filename) return false;
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext === "csv" || ext === "json" || ext === "md" || ext === "xml" || ext === "txt";
}

async function extractDocxText(data: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: data });
  return result.value;
}

async function buildUserContent(
  text: string,
  attachments?: FileAttachment[]
): Promise<UserContent> {
  if (!attachments || attachments.length === 0) return text;

  const parts: UserContent = [{ type: "text" as const, text }];

  for (const attachment of attachments) {
    const mime = attachment.mimeType ?? "application/octet-stream";

    if (mime.startsWith("image/")) {
      parts.push({
        type: "image" as const,
        image: attachment.data,
        mediaType: mime,
      });
    } else if (NATIVE_FILE_MIMES.has(mime)) {
      parts.push({
        type: "file" as const,
        data: attachment.data,
        mediaType: mime,
        filename: attachment.name,
      });
    } else if (mime === DOCX_MIME) {
      try {
        const extracted = await extractDocxText(attachment.data);
        const label = attachment.name ?? "document.docx";
        parts.push({
          type: "text" as const,
          text: `[File: ${label}]\n${extracted}`,
        });
      } catch (err) {
        console.warn("[contentful-bot] failed to extract text from DOCX:", attachment.name, err);
      }
    } else if (isTextMime(mime, attachment.name)) {
      const label = attachment.name ?? "attachment";
      parts.push({
        type: "text" as const,
        text: `[File: ${label}]\n${attachment.data.toString("utf-8")}`,
      });
    } else {
      console.warn(
        `[contentful-bot] unsupported attachment type, skipping: ${attachment.name ?? "unknown"} (${mime})`
      );
    }
  }

  return parts;
}

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

function stripProviderOptions(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    const { providerOptions, ...rest } = msg;
    if (!Array.isArray(rest.content)) return rest as ModelMessage;
    return {
      ...rest,
      content: (rest.content as Array<Record<string, unknown>>).map((part) => {
        if (part && typeof part === "object" && "providerOptions" in part) {
          const { providerOptions: _, ...partRest } = part;
          return partRest;
        }
        return part;
      }),
    } as ModelMessage;
  });
}

async function saveHistory(
  redis: Redis,
  threadId: string,
  messages: ModelMessage[]
): Promise<void> {
  const trimmed = stripProviderOptions(messages).slice(-MAX_HISTORY_MESSAGES);
  await redis.set(
    `ctfl-bot:history:${threadId}`,
    JSON.stringify(trimmed),
    "EX",
    HISTORY_TTL_SECONDS
  );
}

function getIdempotencyLockKey(threadId: string, messageHash: string): string {
  return `ctfl-bot:idempotency:lock:${threadId}:${messageHash}`;
}

function getIdempotencyResponseKey(threadId: string, messageHash: string): string {
  return `ctfl-bot:idempotency:response:${threadId}:${messageHash}`;
}

function hashMessage(message: string): string {
  return createHash("sha256").update(message).digest("hex");
}

function getStepCap(): number {
  const envValue = process.env.AGENT_MAX_STEPS;
  const parsed = envValue ? Number.parseInt(envValue, 10) : NaN;
  if (Number.isFinite(parsed) && parsed >= 5) return parsed;
  return DEFAULT_STEP_CAP;
}

function messageContentToText(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") {
        return record.text;
      }
      if (record.type === "image") {
        return `[image]`;
      }
      if (record.type === "file") {
        const name = typeof record.filename === "string" ? record.filename : "file";
        return `[file: ${name}]`;
      }
      if ("text" in record && typeof record.text === "string") {
        return record.text;
      }
      return "";
    })
    .join("");
}

function responseMessagesToText(messages: ModelMessage[]): string {
  return messages
    .filter((message) => message.role === "assistant")
    .map((message) => messageContentToText(message.content))
    .join("\n")
    .trim();
}

async function runModelPass(input: {
  model: ReturnType<typeof openai>;
  system: string;
  messages: ModelMessage[];
  tools: NonNullable<Parameters<typeof streamText>[0]["tools"]>;
  maxSteps: number;
}): Promise<{ text: string; messages: ModelMessage[] }> {
  const streamedChunks: string[] = [];

  return new Promise((resolve, reject) => {
    const result = streamText({
      model: input.model,
      system: input.system,
      messages: input.messages,
      tools: input.tools,
      stopWhen: stepCountIs(input.maxSteps),
      onFinish: ({ response }) => {
        const responseMessages = response.messages as ModelMessage[];
        const responseText =
          responseMessagesToText(responseMessages) || streamedChunks.join("").trim();
        resolve({ text: responseText, messages: responseMessages });
      },
    });

    void (async () => {
      try {
        for await (const chunk of result.textStream) {
          streamedChunks.push(chunk);
        }
      } catch (error) {
        reject(error);
      }
    })();
  });
}

export function buildSystemPrompt(): string {
  return `You are a Contentful content management assistant in Slack.
Create high-quality, schema-aligned content using the connected space content model.

Before responding:
- Inspect available tools to understand what actions you can perform.
- Review relevant content types and required fields.
- Support any content model discovered at runtime; never assume fixed content type names or fixed relationship shapes.
- If a task depends on existing Contentful data (content type IDs, entry IDs, linked references, slug lookups), resolve it by querying tools and inspecting existing content structure before asking the user.
- When reviewing content types for a request, check each content type's fields for reference (Link) fields. For every reference field found, search existing entries of the referenced content type to identify entries that are relevant to the proposed content. Use matching entries as link targets instead of creating duplicates or leaving references empty.
- Prefer evidence from the space (content model + existing entries/assets) over asking follow-up questions.
- Make reasonable assumptions from discovered naming/content patterns when exact matches are missing, and clearly mark those assumptions as inferred.
- Ask the user only when tool/content-structure lookup cannot produce a reliable answer.
- Users may attach files (images, PDFs, documents, spreadsheets) as context for their request. Use the content of attached files to inform content creation — interpret images, extract information from documents, and incorporate provided material into the content strategy.

Response style (always):
- Be very concise and to the point.
- Keep responses short; default to brief bullets.
- Do not repeat context, dump fields, or explain internal mechanics unless asked.
- Do not include extra sections such as long assumptions, rationale, or next-step menus unless the user requests them.
- Slack supports Markdown output. Prefer concise Markdown that renders cleanly in Slack:
  - Use short headings, bullets, inline code, and inline links when helpful.
  - Avoid HTML and deeply nested or decorative formatting.
  - Keep code fences short and only include them when the user asks for code.

Interaction flow:
- Straightforward or read-only questions: answer directly and briefly.
- Content mutations (create, update, publish):
  1. Present a concise plan with exactly 2 sections:
     - Proposed Content Strategy (max 3 bullets)
     - Clarifying Questions (max 3 questions, only if genuinely needed)
  2. During planning, use read-only tools to inspect the space. Do NOT call mutating tools yet.
  3. Ask clarifying questions only once. After the user replies, treat it as final direction.
  4. When the user approves (e.g. "yes", "proceed", "looks good", or a ✅ reaction), execute the full plan immediately.
  5. If the conversation history already contains your plan and the user's approval, execute — do not re-plan.

Execution rules:
- Complete full requested scope unless a hard blocker occurs.
- Infer and create both required and expected related content from model relationships when fulfilling the request.
- Treat user intent as outcome-focused; infer the right composition depth from discovered schema constraints, references, and existing content patterns.
- For high-composition asks, do not stop at minimal schema satisfaction; deliver the full composed outcome implied by the request.
- Check stable identifiers for idempotency before creating new entries/assets.
- If publish is unavailable, create drafts and continue.
- Use the space default locale when locale is unspecified or locale permissions are unavailable.
- Create/update drafts first, then publish only if capability exists.

Execution summary format (after mutations):
- Keep it short and scannable.
- Use only these sections:
  1) Outcome
  2) Created/Updated
  3) Verification
  4) Blockers
- Include only high-level counts and entry links in this format: https://app.contentful.com/spaces/{spaceId}/entries/{entryId}
- No component-by-component deep breakdown, long notes/assumptions, or next-step suggestions unless explicitly requested.`;
}

function singleMessageStream(message: string): AsyncIterable<string> {
  return (async function* () {
    yield message;
  })();
}

export class NotConnectedError extends Error {
  constructor() {
    super("Contentful is not connected");
    this.name = "NotConnectedError";
  }
}

export type PendingIntent = "approve" | "cancel" | "unclear";

const APPROVE_PATTERN =
  /^(y(es|eah|ep|up)?|sure|go\s*ahead|proceed|do\s*it|looks?\s*good|lgtm|approved?|confirm(ed)?|ok(ay)?|please|pls|ship\s*it|send\s*it|👍|✅)$/i;
const CANCEL_PATTERN =
  /^(no(pe)?|cancel(led)?|stop|never\s*mind|don'?t|abort|nah|nvm|hold\s*off|scratch\s*that|❌|👎)$/i;

export function classifyPendingIntent(messageText: string): PendingIntent {
  const trimmed = messageText.trim();
  if (!trimmed) return "unclear";
  if (APPROVE_PATTERN.test(trimmed)) return "approve";
  if (CANCEL_PATTERN.test(trimmed)) return "cancel";
  return "unclear";
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
  userMessage: string,
  options?: {
    requestScopeId?: string;
    attachments?: FileAttachment[];
  }
): Promise<AsyncIterable<string>> {
  const redis = getRedis();
  const shouldLogAgentTrace = process.env.AGENT_DEBUG === "1";
  const trace = (stage: string, details?: Record<string, unknown>): void => {
    if (!shouldLogAgentTrace) return;
    if (details) {
      console.log(`[agent] ${stage}`, details);
      return;
    }
    console.log(`[agent] ${stage}`);
  };
  const requestScopeId = options?.requestScopeId;
  const messageHash = hashMessage(
    `${requestScopeId ?? "default"}\n${userMessage}`
  );
  const responseKey = getIdempotencyResponseKey(threadId, messageHash);
  const lockKey = getIdempotencyLockKey(threadId, messageHash);
  trace("run:start", {
    threadId,
    requestScopeId: requestScopeId ?? null,
  });

  const [rawToken, history, cachedResponse] = await Promise.all([
    getStoredToken(redis),
    loadHistory(redis, threadId),
    redis.get(responseKey),
  ]);
  trace("run:loaded-state", {
    historyCount: history.length,
    hasToken: Boolean(rawToken),
    hasCachedResponse: Boolean(cachedResponse),
  });

  if (cachedResponse) {
    trace("run:cache-hit");
    await redis.quit();
    return singleMessageStream(cachedResponse);
  }

  if (!rawToken) {
    await redis.quit();
    throw new NotConnectedError();
  }

  const lockAcquired = await redis.set(
    lockKey,
    Date.now().toString(),
    "EX",
    IDEMPOTENCY_TTL_SECONDS,
    "NX"
  );
  if (!lockAcquired) {
    trace("run:lock-not-acquired");
    await redis.quit();
    return singleMessageStream(
      "This request is already running. Reply with `continue` in this thread to resume after the current run completes."
    );
  }
  trace("run:lock-acquired");

  let token: StoredToken;
  try {
    token = await refreshTokenIfNeeded(redis, rawToken);
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      await redis.quit();
      throw new NotConnectedError();
    }
    throw err;
  }
  const userContent = await buildUserContent(userMessage, options?.attachments);
  const updatedHistory: ModelMessage[] = [
    ...history,
    { role: "user", content: userContent },
  ];

  let mcpClient: Awaited<ReturnType<typeof createMCPClient>> | null = null;
  try {
    trace("mcp:connect:start");
    mcpClient = await createMCPClient({
      transport: {
        type: "http",
        url: "https://mcp.contentful.com/mcp",
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
        },
      },
    });
    trace("mcp:connect:ok");

    const tools = await mcpClient.tools();
    trace("mcp:tools-loaded", { totalTools: Object.keys(tools).length });

    const model = openai("gpt-5.4-mini");
    const maxSteps = getStepCap();
    trace("model:run:start", { messageCount: updatedHistory.length, maxSteps });
    const result = await runModelPass({
      model,
      system: buildSystemPrompt(),
      messages: updatedHistory,
      tools,
      maxSteps,
    });
    trace("model:run:done", {
      responseChars: result.text.length,
      responseMessages: result.messages.length,
    });

    await saveHistory(redis, threadId, [...updatedHistory, ...result.messages]);
    await redis.set(responseKey, result.text, "EX", IDEMPOTENCY_TTL_SECONDS);

    return singleMessageStream(result.text);
  } catch (error) {
    trace("run:error", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  } finally {
    trace("run:cleanup");
    try {
      await redis.del(lockKey);
    } catch {
      // ignore idempotency lock cleanup errors
    }
    if (mcpClient) {
      await mcpClient.close();
    }
    await redis.quit();
  }
}
