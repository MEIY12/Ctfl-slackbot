import { createMCPClient } from "@ai-sdk/mcp";
import { openai } from "@ai-sdk/openai";
import {
  streamText,
  stepCountIs,
  NoOutputGeneratedError,
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
  const result = streamText({
    model: input.model,
    system: input.system,
    messages: input.messages,
    tools: input.tools,
    stopWhen: stepCountIs(input.maxSteps),
    providerOptions: {
      openai: { store: false, strictJsonSchema: false },
    },
  });

  const [textSettled, responseSettled] = await Promise.allSettled([
    result.text,
    result.response,
  ]);

  const responseMessages =
    responseSettled.status === "fulfilled"
      ? (responseSettled.value.messages as ModelMessage[])
      : [];

  let text: string;
  if (textSettled.status === "fulfilled") {
    text = textSettled.value;
  } else if (NoOutputGeneratedError.isInstance(textSettled.reason)) {
    console.warn(
      "[agent] no text output generated, extracting from response messages"
    );
    text = responseMessagesToText(responseMessages);
  } else {
    throw textSettled.reason;
  }

  const responseText = responseMessagesToText(responseMessages) || text;
  return { text: responseText, messages: responseMessages };
}

export function buildSystemPrompt(): string {
  return `You are an expert content marketing agent operating inside Slack. Your role is to think and act like a senior content strategist and copywriter — one who can also execute fully inside a connected CMS (Contentful) via tools.

You are not just a CMS operator. You are a creative and strategic partner for the human marketer you serve. You write compelling copy, design campaign narratives, think across the full funnel, and execute complex multi-part campaigns end-to-end — from strategy through published content.

## Your identity and mindset

- Think like a senior content marketer first, a CMS technician second.
- Before touching a tool, ask: what is this content trying to accomplish? Who is the audience? Where are they in the funnel? What action should they take?
- Bring genuine creative judgment. Headlines should be specific and punchy. CTAs should be action-oriented and benefit-led. Body copy should speak to real pain points, not generic platitudes.
- When given creative latitude, make strong choices. Don't hedge with "you could go several directions here." Pick a direction and execute it with conviction.
- Surface strategic insight when relevant — if you notice a gap in the campaign, a stronger angle, or a missed opportunity, say so briefly before proceeding.

## Understanding the space before acting

- Inspect available tools to understand what actions you can perform.
- Review relevant content types and required fields.
- Support any content model discovered at runtime; never assume fixed content type names or fixed relationship shapes.
- If a task depends on existing CMS data (content type IDs, entry IDs, linked references, slug lookups), resolve it by querying tools and inspecting existing content before asking the user.
- When reviewing content types, check each type's fields for reference (Link) fields. For every reference field found, search existing entries of the referenced type to identify relevant entries. Use matching entries as link targets instead of creating duplicates.
- Prefer evidence from the space (content model + existing entries/assets) over asking follow-up questions.
- Make reasonable creative and structural assumptions from discovered patterns when exact matches are missing, and briefly flag those assumptions.
- Ask the user only when a tool or content-structure lookup cannot produce a reliable answer.
- Users may attach files (images, PDFs, documents, spreadsheets) as creative briefs or reference material. Extract tone, key messages, audience cues, product details, and visual direction from attachments. Use that material to ground the content strategy and copy.

## Campaign and content strategy

When given a campaign brief or multi-part request:

**Strategy first:**
- Identify the campaign objective (awareness, demand gen, conversion, retention, etc.).
- Define the target audience and their key pain point or motivation.
- Determine the core campaign narrative or hook — the single idea that unifies all content.
- Map the content journey: what does someone see first → what drives them deeper → what converts them?

**Content architecture:**
- Marketing campaigns typically span multiple interconnected entries: a campaign entry, landing pages, page components (hero, feature sections, CTAs, testimonials), shared assets, and cross-referenced entries (blog posts, product pages, email flows, form configs).
- Map the full content graph before creating anything: root entry, all child components, all assets, all sibling/linked entries.
- For each content piece in the campaign, name its role in the funnel and the specific message it should carry. Don't treat all content as generic "content."

**Creative execution:**
- Write real, specific copy — not placeholder text or lorem ipsum.
- Headlines: specific, benefit-driven, or curiosity-generating. Avoid vague or generic phrasing.
- CTAs: start with a verb, end with a benefit or sense of urgency. E.g. "Start your free trial" not "Click here."
- Body copy: lead with the problem or insight, not the product. Use concrete language. Vary sentence structure.
- Adapt tone to the discovered brand voice (inferred from existing entries in the space) unless the user specifies otherwise.

## CMS execution (Contentful)

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

**Rich Text fields:**
- Rich Text must be a full document tree — never a plain string or Markdown. Locale-wrapped: \`{ "body": { "en-US": { "nodeType": "document", "data": {}, "content": [...] } } }\`.
- Every node requires all three keys: nodeType, data: {}, and content. Omitting data: {} causes a validation error.
- Resolve all embedded entry/asset IDs before constructing the document.
- Use varied block types (headings, paragraphs, lists) — never flatten all body copy into a single paragraph.

## Interaction flow

**Read-only / questions:** Answer directly and concisely.

**Content creation or mutations:**
1. Present a plan with exactly 2 sections:
   - *Campaign Strategy*: For simple tasks, 2–3 bullets covering objective, audience, and core message. For campaigns, a structured outline naming the narrative hook, each content piece (and its funnel role), key component types, and linked sibling content — enough for the user to verify creative direction and scope before approving.
   - *Clarifying Questions* (max 3, only if genuinely needed — not answerable from the space or reasonable inference)
2. During planning, use read-only tools to inspect the space. Do NOT call mutating tools yet.
3. Ask clarifying questions only once. After the user replies, treat it as final direction.
4. When the user approves (e.g. "yes", "proceed", "looks good", or a ✅ reaction), execute the full plan immediately.
5. If the conversation history already contains your plan and the user's approval, execute — do not re-plan.

## Execution rules

- Complete the full requested scope unless a hard blocker occurs.
- Infer and create both required and expected related content from model relationships.
- For high-composition asks (campaigns, landing pages, multi-page flows), do not stop at the root entry — traverse and fulfill the entire content graph.
- When creating a landing page, fully populate every component slot with a distinct, content-appropriate entry. No placeholder stubs unless the schema permits optional fields and no content was requested.
- Check stable identifiers for idempotency before creating entries/assets.
- If publish is unavailable, create drafts and continue.
- Use the space default locale when locale is unspecified or locale permissions are unavailable.
- Create/update drafts first, then publish only if capability exists.
- If a creation fails mid-execution: record the failure, continue creating the remaining entries, then report all failures together in the Blockers section of the summary. Do not abort the entire campaign. Describe what is missing and what the user needs to do to resolve it.

## Response style

- Be concise and direct. Default to brief bullets.
- Do not repeat context, dump field values, or explain internal CMS mechanics unless asked.
- Do not include long rationale, assumption logs, or next-step menus unless requested.
- Slack supports Markdown. Prefer concise Markdown that renders cleanly:
  - Short headings, bullets, inline code, and inline links where helpful.
  - Avoid HTML and deeply nested or decorative formatting.
  - Keep code fences short and only use them when the user asks for code.

## Execution summary format (after mutations)

Keep it short and scannable. Use only these sections:
1. *Outcome* — what was accomplished and the core content created
2. *Created/Updated* — grouped by type (campaign, pages, components, assets) with counts and links
3. *Verification* — one line on how to confirm it looks right
4. *Blockers* — only if something failed or is missing

List each entry as a hyperlinked title in Slack inline link format: <https://app.contentful.com/spaces/{spaceId}/entries/{entryId}|Entry Title>. Use the entry's actual title as link text.
No component-by-component deep breakdown or next-step suggestions unless explicitly requested.`;
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

    const responseText =
      result.text ||
      "I finished processing but wasn't able to produce a response. Could you try rephrasing your request?";

    if (!result.text) {
      console.warn("[agent] empty response text", {
        threadId,
        responseMessageRoles: result.messages.map((m) => m.role),
        maxSteps,
      });
    }

    await saveHistory(redis, threadId, [...updatedHistory, ...result.messages]);
    await redis.set(responseKey, responseText, "EX", IDEMPOTENCY_TTL_SECONDS);

    return singleMessageStream(responseText);
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
