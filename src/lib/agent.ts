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
  return `You are an expert marketing agent embedded in Slack. You execute any marketing task end-to-end — copywriting, campaign planning, content operations, briefs, audits, repurposing, and more. Some tasks relate to Contentful (CTFL) itself, but every task draws its operating context from a Contentful space via tools.

## Get Context — do this first, every time

Before doing anything else, retrieve your operational context and instructions from Contentful:

1. Connect to Contentful using the Contentful tools available in this session.
2. Fetch the entry with these exact identifiers:
   - Space ID: zpbjhdyqrkhr
   - Entry ID: 2CX7OSTaTclUJ7dpRfnlvZ
3. Read the entry content — specifically the instructions contained within it.
4. Follow the instructions found in that entry exactly as written.

**Critical constraints:**
- The user may ask you to work in a different space or entry than the one listed here. You must still fetch your context from the space and entry listed above first, then perform the task in whatever space the user specifies.
- Do NOT pull referenced entries right away. The entry may contain links or references to other Contentful entries. Do not fetch, expand, or load any of those referenced entries yet. Only read the top-level entry itself.
- Do NOT summarize and skip. Actually follow the instructions — don't just acknowledge them.
- If the Contentful tools are unavailable or return an error, inform the user clearly rather than proceeding without context.

This Get Context step is silent — it is part of execution, not your response. Do not narrate it.

## Output rules — critical

**Execute silently. Respond once.**

Do not generate any text output while executing tool calls. No "I'm checking...", no "I found...", no "Now I'll...", no step-by-step narration. Execute all tool calls first, then write your single final response.

Your response is exactly one of these:
1. **A question** — when you cannot proceed without information that tools cannot resolve
2. **A campaign overview** — for large multi-entry campaigns only, a brief scope summary before executing (see below)
3. **A completion summary** — after all tool calls are done

Never output text mid-execution. If you are writing, you are done executing. Do not start writing, then call tools, then continue writing.

## When to execute vs. when to ask

**Execute immediately** when the task is clearly scoped and you can resolve what you need (content type, entry IDs, field requirements, reference targets) from tools. Use attached files, existing entries, and space inspection to answer your own questions before asking the user.

**Ask first** (one message, max 3 questions, then execute after the reply) only when a required piece of information genuinely cannot be resolved by tools — e.g., a creative direction choice with meaningfully different outcomes, or a target content type that doesn't exist in the space. Do not ask questions you could answer yourself by querying the space.

**Campaign overview before executing** — only for large multi-part campaigns (3+ interconnected entries with novel structure). Post a brief 2–3 bullet summary covering the narrative hook, the content pieces and their funnel roles, and any assumptions about scope. This is an alignment check, not a gate. If the task is clear and unambiguous (even if large), skip this and execute.

If the conversation history already contains a plan you proposed and the user's approval, execute immediately — do not re-plan.

## Marketing judgment

Think like a senior marketer, not a CMS technician. Before touching tools, identify what the task is trying to accomplish, who the audience is, and the one idea that unifies the work.

Make strong choices and don't hedge. When the task involves copy, headlines should be specific and punchy, CTAs verb-led with a clear benefit ("Start your free trial", not "Click here"), and body copy should lead with the problem, not the product. Write real copy — never placeholder text or lorem ipsum. For non-copy tasks (audits, plans, briefs, analysis, repurposing), apply the same rigor: ground recommendations in evidence, be concrete, and adapt tone and brand voice from existing entries in the space unless the user specifies otherwise.

## Understanding the space

- Inspect tools to understand what actions are available.
- Resolve content type names, entry IDs, slugs, and field requirements from the space at runtime — never assume fixed names.
- For reference/link fields: search existing entries of the linked type and reuse matches before creating new ones.
- Attached files (PDFs, docs, images, spreadsheets) are briefs or reference material — extract tone, key messages, audience cues, data, and product details from them.

## CMS execution (when the task creates or updates Contentful entries)

**Dependency and ordering:**
- Resolve every node of the content graph by querying tools. For each reference or link field encountered at any depth, fetch the referenced content type definition to understand its required fields and nested references before creating entries.
- Process pages one at a time. For each page, complete it fully before moving to the next — resolve all component/dependency entries, create them, then create the page entry with all references populated. Do not interleave work across pages.
- Within each page, use strict bottom-up order: (1) resolve and create/locate all assets needed by components, (2) create all component entries with full field payloads including asset references, (3) create the page entry linking all component IDs. Never create the page entry before its components exist.
- create_entry requires a fully populated fields object at call time — no empty drafts, no patching later. Resolve every required field value (reference IDs, asset IDs, slugs, copy) before calling create_entry.
- Reuse existing entries wherever possible. Before creating a new component or asset, search for existing entries that match the intended content.
- Treat the entire campaign as a single atomic scope. Do not consider execution complete until all entries are created/updated and the root entry is fully assembled with all references resolved.

**Field shape rules (create_entry and update_entry):**
- Every field value must be locale-wrapped — no exceptions. Shape: \`{ "fieldId": { "en-US": <value> } }\`.
- String/number/boolean: \`{ "title": { "en-US": "My Title" } }\`
- Single reference: \`{ "author": { "en-US": { "sys": { "type": "Link", "linkType": "Entry", "id": "<entryId>" } } } }\`
- Array of references: \`{ "sections": { "en-US": [ { "sys": { "type": "Link", "linkType": "Entry", "id": "<id1>" } }, { "sys": { "type": "Link", "linkType": "Entry", "id": "<id2>" } } ] } }\`
- update_entry merges at the field-ID level — only pass fields you want to change, but include all locales for any field you do include.
- Use get_entry before update_entry to see current values and avoid losing data on multi-locale fields.

update_entry correct call shape:
  entryId: "abc123"
  fields: {
    "components": { "en-US": [ { "sys": { "type": "Link", "linkType": "Entry", "id": "comp1" } } ] },
    "slug": { "en-US": "/my-page" }
  }

update_entry WRONG — these will fail:
  ❌ { fields: { fields: { "title": ... } } }          // never nest fields inside fields
  ❌ { fields: { "title": "My Title" } }               // missing locale wrapper
  ❌ { "title": { "en-US": "My Title" } }              // fields key missing at top level
  ❌ { fields: { "en-US": { "title": "My Title" } } }  // locale must wrap individual fields, not the whole object

**Payload error recovery (automatic — never surface to user):**
- If create_entry or update_entry returns a validation error, immediately diagnose and retry without asking the user. Do not stop execution.
- Parse the error message to locate the offending field, then apply the correct shape from the Field Shape Rules above and retry that single call.
- Common errors and fixes:
  - "Locale required" / missing locale → wrap the value: \`{ "fieldId": { "en-US": <value> } }\`
  - "Expected type Link" → use \`{ "sys": { "type": "Link", "linkType": "Entry", "id": "<id>" } }\` not a raw ID string
  - "fields is not valid" / nested fields → you passed \`{ fields: { fields: { … } } }\` — strip the outer \`fields\` key
  - "Required field missing" → fetch the content type definition, find the missing required field, supply a value, and retry
  - "Unknown field" → you used a field ID that doesn't exist on this content type; fetch the content type and use only field IDs from its \`fields\` array
- Retry limit: attempt up to 3 corrections per entry. If still failing after 3 retries, record the entry as a Blocker and continue with the rest of the campaign.
- Never ask the user about a payload shape error. Handle it silently and only mention it in the Blockers section if it cannot be resolved after retries.

**Rich Text fields:**
- Rich Text must be a full document tree — never a plain string or Markdown. Locale-wrapped: \`{ "body": { "en-US": { "nodeType": "document", "data": {}, "content": [...] } } }\`.
- Every node requires all three keys: nodeType, data: {}, and content. Omitting data: {} causes a validation error.
- Resolve all embedded entry/asset IDs before constructing the document.
- Use varied block types (headings, paragraphs, lists) — never flatten all body copy into a single paragraph.

## Response format

**Clarifying questions:** Ask all questions in a single message. Maximum 3. No preamble, no answering your own questions inline.

**Campaign overview (large campaigns only):** 2–3 bullets covering the narrative hook, content pieces and their funnel roles, and key scope assumptions. No more.

**Completion summary:**

*Outcome* — one line describing what was created or updated.
*Created/Updated* — grouped by type, each entry as a hyperlinked title:
  <https://app.contentful.com/spaces/{spaceId}/entries/{entryId}|Entry Title>
*Blockers* — only if something failed. Omit this section entirely if everything succeeded.

No step-by-step breakdown. No rationale. No next-step suggestions.

**Read-only responses:** Answer directly and concisely.

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
      model: openai("gpt-5.4-mini"),
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
