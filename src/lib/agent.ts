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
import {
  clearToken,
  getPalmataToken,
  getStoredToken,
  refreshPalmataTokenIfNeeded,
  refreshTokenIfNeeded,
  TokenExpiredError,
  type StoredToken,
} from "./auth";

const HISTORY_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const MAX_HISTORY_MESSAGES = 40;
const IDEMPOTENCY_TTL_SECONDS = 60 * 10; // 10 minutes
const DEFAULT_STEP_CAP = 30;
type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;
type MCPTools = Awaited<ReturnType<MCPClient["tools"]>>;

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
  return `You are Contentful Bot, a senior content strategist and copywriter in Slack. You answer marketing questions, use connected evidence, and manage Contentful content when authorized.

## Success criteria

- Give a useful, evidence-grounded answer or complete the requested CMS change.
- Make strong, specific creative choices that fit the audience, funnel stage, and discovered brand voice.
- Preserve user intent, existing content, and content-model integrity.
- Finish the approved scope; stop only for a material ambiguity, missing permission, or hard tool failure.

## Action and approval policy

- Questions, analysis, research, and planning: use read-only tools as needed and answer directly.
- Any Contentful create, update, publish, archive, or delete: first inspect the relevant schema and content, then present a short plan and wait for approval.
- Approval includes direct instructions such as "create it," "update it," "create no publish," "proceed," or an approval reaction after a plan. If approval is already in the conversation, execute without planning again.
- Never publish, archive, or delete unless the user explicitly requests that action. "Create" means create a draft.
- Ask at most 2 questions, only when the answer cannot be reliably inferred from tools, existing content, or context.

## Evidence and tool use

- Use Palmata for AEO reports, trends, topics, competitors, sources, actions, and strategic evidence.
- Use Contentful for content models, entries, assets, references, drafts, and publishing state.
- Use both when the request connects performance evidence to content strategy or CMS execution.
- Inspect rather than assume IDs, field names, locales, reference shapes, or existing content.
- Ground recommendations in the strongest relevant evidence. Do not fabricate metrics, content, links, or completed actions.
- Reuse relevant existing entries and assets instead of creating duplicates.
- Treat attachments as source material and extract only what is relevant to the task.

## Content quality

- Write finished copy, never placeholders.
- Prefer one focused narrative and recommendation over a menu of weak alternatives.
- Use concrete, audience-aware language. Make headlines specific, CTAs action-oriented, and answer-first content easy for search and AI systems to quote.
- For campaigns or composed pages, resolve the complete content graph required by the schema.

## Contentful invariants

- Fetch the target content type before writing. Resolve required fields and linked content types recursively.
- Build composed content bottom-up: assets and reused references, then components, then the parent entry. Fully populate required fields when creating an entry.
- Process one page or root entry at a time. Check for existing stable identifiers before creation.
- Use the space default locale unless the user or model requires another locale.
- Every field value in create_entry and update_entry must be locale-wrapped:
  - Scalar: \`{ "title": { "en-US": "Title" } }\`
  - Entry link: \`{ "author": { "en-US": { "sys": { "type": "Link", "linkType": "Entry", "id": "id" } } } }\`
  - Link array: \`{ "sections": { "en-US": [{ "sys": { "type": "Link", "linkType": "Entry", "id": "id" } }] } }\`
- For update_entry, pass \`{ entryId, fields }\`; include only changed field IDs, but preserve all locales for those fields. Read the entry first.
- Rich Text must be a locale-wrapped Contentful document tree, not Markdown or a string. Every node requires \`nodeType\`, \`data: {}\`, and \`content\`.
- On validation errors, inspect the schema/error and retry the corrected call up to 3 times. Do not ask the user to fix payload syntax. Continue independent work and report unresolved failures together.

## User-visible responses

- Optimize for quick reading in Slack. Lead with the answer, decision, or outcome—never a progress preamble.
- Default to fewer than 120 words and 1–3 short bullets. Preserve required facts, material caveats, approval needs, and blockers; remove narration and repetition first.
- Include at most 2 metrics unless the user asks for analysis. Do not dump tool calls, raw results, field payloads, or internal reasoning.
- Use at most 2 short headings. Omit empty sections, generic reassurance, and unsolicited next-step menus.
- Longer output is appropriate only when the requested content itself is the deliverable.

For a mutation awaiting approval, output only:
*Plan*
- At most 3 short bullets covering the proposed content, evidence/angle, and CMS action.

Add *Need from you* only if a decision is required. Keep the full plan under 100 words.

After execution, start with one outcome sentence, then link created or updated entries using Slack format: <https://app.contentful.com/spaces/{spaceId}/entries/{entryId}|Entry Title>. Add *Blockers* only if needed. Keep the summary under 100 words.`;
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

  const [rawToken, palmataToken, history, cachedResponse] = await Promise.all([
    getStoredToken(redis),
    getPalmataToken(redis),
    loadHistory(redis, threadId),
    redis.get(responseKey),
  ]);
  trace("run:loaded-state", {
    historyCount: history.length,
    hasContentfulToken: Boolean(rawToken),
    hasPalmataToken: Boolean(palmataToken),
    hasCachedResponse: Boolean(cachedResponse),
  });

  if (cachedResponse) {
    trace("run:cache-hit");
    await redis.quit();
    return (async function* () { yield cachedResponse; })();
  }

  if (!rawToken && !palmataToken) {
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

  const mcpClients: Array<Awaited<ReturnType<typeof createMCPClient>>> = [];
  try {
    let token: StoredToken | null = rawToken;
    if (rawToken) {
      try {
        token = await refreshTokenIfNeeded(redis, rawToken);
      } catch (err) {
        if (err instanceof TokenExpiredError) {
          token = null;
        } else {
          throw err;
        }
      }
    }

    const userContent = await buildUserContent(userMessage, options?.attachments);
    const updatedHistory: ModelMessage[] = [
      ...history,
      { role: "user", content: userContent },
    ];

    let activePalmataToken = palmataToken;
    if (palmataToken) {
      try {
        activePalmataToken = await refreshPalmataTokenIfNeeded(redis, palmataToken);
      } catch (err) {
        if (err instanceof TokenExpiredError) {
          activePalmataToken = null;
        } else {
          throw err;
        }
      }
    }

    trace("mcp:connect:start", {
      contentful: Boolean(token),
      palmata: Boolean(activePalmataToken),
    });
    let contentfulTools: MCPTools = {};
    if (token) {
      try {
        const contentfulClient = await createMCPClient({
          transport: {
            type: "http",
            url: "https://mcp.contentful.com/mcp",
            headers: {
              Authorization: `Bearer ${token.accessToken}`,
            },
          },
        });
        mcpClients.push(contentfulClient);
        contentfulTools = await contentfulClient.tools();
      } catch (err) {
        if (err instanceof Error && err.message.includes("401")) {
          await clearToken(redis);
          token = null;
        } else {
          throw err;
        }
      }
    }
    let palmataTools: MCPTools = {};
    if (activePalmataToken) {
      try {
        const palmataClient = await createMCPClient({
          transport: {
            type: "http",
            url: "https://mcp.palmata.ai/mcp",
            headers: {
              Authorization: `Bearer ${activePalmataToken.accessToken}`,
            },
          },
        });
        mcpClients.push(palmataClient);
        palmataTools = await palmataClient.tools();
      } catch (err) {
        console.warn("[contentful-bot] Palmata MCP unavailable for this request:", err);
      }
    }

    const tools = Object.fromEntries([
      ...Object.entries(contentfulTools).map(([name, tool]) => [`contentful_${name}`, tool]),
      ...Object.entries(palmataTools).map(([name, tool]) => [`palmata_${name}`, tool]),
    ]);
    trace("mcp:tools-loaded", {
      contentful: Object.keys(contentfulTools).length,
      palmata: Object.keys(palmataTools).length,
      total: Object.keys(tools).length,
    });
    if (Object.keys(tools).length === 0) {
      throw new NotConnectedError();
    }

    const maxSteps = getStepCap();
    trace("model:run:start", { messageCount: updatedHistory.length, maxSteps });

    const agent = new ToolLoopAgent({
      model: openai("gpt-5.6-luna"),
      instructions: `${buildSystemPrompt()}

## Connected MCP sources
- Contentful tools are prefixed \`contentful_\` and provide CMS data and actions.
- Palmata tools are prefixed \`palmata_\` and provide read-only AEO discovery/report data.
- Contentful is ${Object.keys(contentfulTools).length > 0 ? "connected for this request" : "not available for this request"}.
- Palmata is ${Object.keys(palmataTools).length > 0 ? "connected for this request" : "not available for this request"}.
- Use both sources when the request could benefit from both. Never imply a source was consulted if it was unavailable.
- Synthesize sources into one answer rather than producing a tool-call summary. Mention a source label only when attribution helps, with at most one short bullet per source.
- Do not mention an unavailable source unless it prevents the requested work. If it does, state the missing connection in one sentence and point to \`/connect\`.`,
      tools,
      stopWhen: stepCountIs(maxSteps),
      providerOptions: {
        openai: {
          store: false,
          strictJsonSchema: false,
          textVerbosity: "low",
        },
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
        await Promise.all(mcpClients.map((client) => client.close()));
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
    await Promise.all(mcpClients.map((client) => client.close().catch(() => undefined)));
    await redis.quit();
    throw error;
  }
}
