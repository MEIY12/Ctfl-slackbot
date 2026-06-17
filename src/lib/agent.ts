import { createMCPClient } from "@ai-sdk/mcp";
import { openai } from "@ai-sdk/openai";
import {
  ToolLoopAgent,
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

/**
 * Replace file and image parts in user messages with text placeholders before
 * persisting to or reading from Redis. Node.js Buffers serialise to plain
 * objects ({type:"Buffer",data:[...]}) via JSON.stringify, which fails the AI
 * SDK ModelMessage schema check on the next load. The binary content was
 * already consumed in the turn it arrived; keeping a text placeholder is
 * sufficient for future-turn context. Running this on both save and load
 * repairs any already-stored messages that contain raw Buffer objects.
 */
function stripBinaryContent(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "user") return message;
    if (typeof message.content === "string") return message;
    if (!Array.isArray(message.content)) return message;
    const sanitized = (message.content as unknown[]).map((part) => {
      if (!part || typeof part !== "object") return part;
      const p = part as Record<string, unknown>;
      if (p.type === "file") {
        const name = typeof p.filename === "string" ? p.filename : "file";
        const mime = typeof p.mediaType === "string" ? p.mediaType : "unknown";
        return { type: "text" as const, text: `[attached file: ${name} (${mime})]` };
      }
      if (p.type === "image") {
        const mime = typeof p.mediaType === "string" ? p.mediaType : "image";
        return { type: "text" as const, text: `[attached image (${mime})]` };
      }
      return part;
    });
    return { ...message, content: sanitized } as ModelMessage;
  });
}

async function loadHistory(
  redis: Redis,
  threadId: string
): Promise<ModelMessage[]> {
  const raw = await redis.get(`ctfl-bot:history:${threadId}`);
  if (!raw) return [];
  try {
    return stripBinaryContent(JSON.parse(raw) as ModelMessage[]);
  } catch {
    return [];
  }
}

/**
 * Trim history to at most maxMessages, always starting at a user-role message.
 * A plain slice(-N) can orphan tool-result messages at index 0 (no matching
 * assistant tool-call message), which causes structurally broken context on the
 * next turn and is the primary driver of payload shape errors on message 2+.
 */
function trimHistory(messages: ModelMessage[], maxMessages: number): ModelMessage[] {
  if (messages.length <= maxMessages) return messages;
  const sliced = messages.slice(-maxMessages);
  const firstUserIdx = sliced.findIndex((m) => m.role === "user");
  return firstUserIdx > 0 ? sliced.slice(firstUserIdx) : sliced;
}

async function saveHistory(
  redis: Redis,
  threadId: string,
  messages: ModelMessage[]
): Promise<void> {
  const trimmed = trimHistory(stripBinaryContent(messages), MAX_HISTORY_MESSAGES);
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


export function buildSystemPrompt(): string {
  return `You are an expert marketing agent embedded in Slack. You produce marketing outputs — copy, campaign ideas, briefs, messaging, audits, repurposing, analysis, recommendations, and more. Some tasks relate to Contentful (CTFL) itself, but every task is grounded in context you pull from Contentful.

You use Contentful strictly as a READ-ONLY source of context. You never create, update, publish, delete, or otherwise modify any Contentful entry, asset, content type, or space. Your job is to read existing content and use it to generate better, more on-brand, more grounded outputs that you deliver back in Slack.

## Get Context — do this FIRST, on EVERY message

Before responding to any request — every single time the bot is used, including follow-ups within a thread — retrieve your operational context and instructions from Contentful:

1. Connect to Contentful using the Contentful tools available in this session.
2. Fetch the entry with these exact identifiers:
   - Space ID: zpbjhdyqrkhr
   - Entry ID: 2CX7OSTaTclUJ7dpRfnlvZ
3. Read the entry content — specifically the instructions contained within it.
4. **Retrieve the referenced entries.** This top-level entry links to other Contentful entries, and those referenced entries are where the real context lives. Fetch every entry referenced from it (follow the links/reference fields and load each linked entry's full content) before doing the work. Do this every time.
5. Follow the instructions found in the entry exactly as written, grounded in the content of the referenced entries.

**Critical constraints:**
- Pull this context on every turn. Do not assume a previous turn's fetch is still valid or skip it because you fetched it earlier in the thread — re-fetch the top-level entry AND its referenced entries each time before doing the work.
- The referenced entries are mandatory, not optional. Do not stop at the top-level entry — it mainly points to the entries that actually hold the context. Retrieve all of them every time.
- The user may ask you to pull additional context from a different space or entry. Always fetch the context entry above (and its references) FIRST, then read whatever else the user points you to.
- Do NOT summarize and skip. Actually read and follow the instructions and the referenced content — don't just acknowledge them.
- If the Contentful tools are unavailable or return an error, inform the user clearly rather than proceeding without context.

This Get Context step is silent — it is part of execution, not your response. Do not narrate it.

## Output rules — critical

**Pull context silently. Respond once.**

Do not generate any text output while fetching context or reading entries. No "I'm checking...", no "I found...", no "Let me look...", no step-by-step narration. Do all the reading first, then write your single final response.

Your response is exactly one of these:
1. **A question** — when you cannot proceed without information that the context and tools cannot resolve
2. **The marketing output** — the actual deliverable the user asked for

Never output text mid-execution. If you are writing your response, you are done reading.

## When to answer vs. when to ask

**Answer immediately** when the task is clearly scoped and you can ground it in the context you pulled. Use the context entry, any entries the user points to, and attached files to answer your own questions before asking the user.

**Ask first** (one message, max 3 questions, then proceed after the reply) only when a required piece of information genuinely cannot be resolved from context — e.g., a creative direction with meaningfully different outcomes. Do not ask questions you could answer yourself from the context you pulled.

## Marketing judgment

Think like a senior marketer. Before producing anything, identify what the output is trying to accomplish, who the audience is, and the one idea that unifies the work — using the brand voice, positioning, and details found in the Contentful context.

Make strong choices and don't hedge. When the task involves copy, headlines should be specific and punchy, CTAs verb-led with a clear benefit ("Start your free trial", not "Click here"), and body copy should lead with the problem, not the product. Write real copy — never placeholder text or lorem ipsum. For non-copy tasks (audits, plans, briefs, analysis, repurposing), apply the same rigor: ground every recommendation in the context you pulled, be concrete, and cite the specific entries or details that informed your output when it helps the user trust it.

## Using context

- Always anchor outputs in what you read from Contentful — tone, messaging, positioning, product details, audience cues, and existing examples.
- Adapt to the brand voice inferred from the context unless the user specifies otherwise.
- If the user references specific entries, slugs, or topics, read those entries to ground the output — but never modify them.
- Attached files (PDFs, docs, images, spreadsheets) are additional briefs or reference material — extract tone, key messages, audience cues, data, and product details from them and combine with the Contentful context.

## Response format

**Clarifying questions:** Ask all questions in a single message. Maximum 3. No preamble, no answering your own questions inline.

**Marketing output:** Deliver the requested output directly and in full. Lead with the deliverable, not with process. No step-by-step breakdown of how you pulled context, no rationale dumps, and no next-step menus unless the user asks.

After the deliverable, include a short *Context used* section that surfaces the key details you pulled from the Contentful context and how they shaped the output — e.g. brand voice/tone, positioning, target audience, product details, key messages, or constraints you applied. Keep it to a few tight bullets, only the details that actually informed the work, not a full dump of the entry.

When it adds value, reference the entries that grounded your output as inline links: <https://app.contentful.com/spaces/{spaceId}/entries/{entryId}|Entry Title>.

Slack supports Markdown. Use short headings, bullets, and inline links. No HTML.`;
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
    return (async function* () { yield cachedResponse; })();
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
    return (async function* () {
      yield "This request is already running. Reply with `continue` in this thread to resume after the current run completes.";
    })();
  }
  trace("run:lock-acquired");

  let mcpClient: Awaited<ReturnType<typeof createMCPClient>> | null = null;
  try {
    let token: StoredToken;
    try {
      token = await refreshTokenIfNeeded(redis, rawToken);
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        throw new NotConnectedError();
      }
      throw err;
    }

    const userContent = await buildUserContent(userMessage, options?.attachments);
    const updatedHistory: ModelMessage[] = [
      ...history,
      { role: "user", content: userContent },
    ];

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

    const maxSteps = getStepCap();
    trace("model:run:start", { messageCount: updatedHistory.length, maxSteps });

    const agent = new ToolLoopAgent({
      model: openai("gpt-5.4-mini-2026-03-17"),
      instructions: buildSystemPrompt(),
      tools,
      stopWhen: stepCountIs(maxSteps),
      providerOptions: {
        openai: { store: false, strictJsonSchema: false },
      },
    });

    const streamResult = await agent.stream({ messages: updatedHistory });

    // Generator streams tokens to Chat SDK and performs cleanup after completion.
    // Cleanup lives here (not in an outer finally) so it runs after the consumer
    // finishes draining the stream, not when runAgent() returns.
    async function* textWithCleanup(): AsyncGenerator<string> {
      let accumulatedText = "";
      try {
        for await (const chunk of streamResult.textStream) {
          accumulatedText += chunk;
          yield chunk;
        }
        const response = await streamResult.response;
        trace("model:run:done", {
          responseChars: accumulatedText.length,
          responseMessages: response.messages.length,
        });
        const responseText =
          accumulatedText ||
          "I finished processing but wasn't able to produce a response. Could you try rephrasing your request?";
        if (!accumulatedText) {
          console.warn("[agent] empty response text", { threadId, maxSteps });
        }
        await saveHistory(redis, threadId, [
          ...updatedHistory,
          ...(response.messages as ModelMessage[]),
        ]);
        await redis.set(responseKey, responseText, "EX", IDEMPOTENCY_TTL_SECONDS);
      } finally {
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

    return textWithCleanup();
  } catch (error) {
    trace("run:error", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    // Setup failed before stream started — clean up immediately.
    try { await redis.del(lockKey); } catch { /* ignore */ }
    if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
    await redis.quit();
    throw error;
  }
}
