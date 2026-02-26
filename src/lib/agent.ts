import { createMCPClient } from "@ai-sdk/mcp";
import { openai } from "@ai-sdk/openai";
import { streamText, stepCountIs, type ModelMessage } from "ai";
import { createHash, randomUUID } from "crypto";
import Redis from "ioredis";
import { getStoredToken, refreshTokenIfNeeded, type StoredToken } from "./auth";

const HISTORY_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const MAX_HISTORY_MESSAGES = 40;
const CAMPAIGN_JOB_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const IDEMPOTENCY_TTL_SECONDS = 60 * 10; // 10 minutes
const DEFAULT_STANDARD_STEP_CAP = 30;
const DEFAULT_CAMPAIGN_STEP_CAP = 80;

type CampaignStatus = "running" | "completed" | "failed";
type CampaignPhase =
  | "planning"
  | "ready_for_execution"
  | "executing"
  | "verifying"
  | "completed";

interface CampaignExecutionPlan {
  objective: string;
  executionStrategy: string;
  idempotencyApproach: string;
  rollbackStrategy: string;
}

interface CampaignJobState {
  jobId: string;
  threadId: string;
  status: CampaignStatus;
  phase: CampaignPhase;
  attempts: number;
  startedAt: number;
  updatedAt: number;
  lastMessageHash: string;
  idempotencyKey: string;
  lastError?: string;
  createdEntryLinks: string[];
  plan: CampaignExecutionPlan;
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

function getCampaignJobKey(threadId: string): string {
  return `ctfl-bot:campaign-job:${threadId}`;
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

function getStepCap(
  isCampaign: boolean,
  executionMode: "plan" | "execute"
): number {
  const envValue = process.env.AGENT_MAX_STEPS;
  const parsed = envValue ? Number.parseInt(envValue, 10) : NaN;
  if (Number.isFinite(parsed) && parsed >= 5) return parsed;

  if (executionMode === "plan") return DEFAULT_STANDARD_STEP_CAP;
  return isCampaign ? DEFAULT_CAMPAIGN_STEP_CAP : DEFAULT_STANDARD_STEP_CAP;
}

function detectCampaignIntent(userMessage: string): boolean {
  return /\b(campaign|holistic|multi[- ]step|many entries|multiple entries|orchestrat|launch)\b/i.test(
    userMessage
  );
}

async function loadCampaignJob(
  redis: Redis,
  threadId: string
): Promise<CampaignJobState | null> {
  const raw = await redis.get(getCampaignJobKey(threadId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CampaignJobState;
  } catch {
    return null;
  }
}

async function saveCampaignJob(redis: Redis, job: CampaignJobState): Promise<void> {
  await redis.set(
    getCampaignJobKey(job.threadId),
    JSON.stringify(job),
    "EX",
    CAMPAIGN_JOB_TTL_SECONDS
  );
}

function buildExecutionPlan(userMessage: string): CampaignExecutionPlan {
  return {
    objective: userMessage,
    executionStrategy:
      "Use a two-step flow: concise strategy first, then execute all approved work in a single pass with a final verification summary.",
    idempotencyApproach:
      "Search for existing entries/assets by unique slug, title, or campaign key before creating new content.",
    rollbackStrategy:
      "Track all created entry links. If verification fails, return an ordered rollback recommendation for those created items.",
  };
}

function messageContentToText(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") return text;
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

function extractCreatedEntryLinks(text: string): string[] {
  const linkRegex =
    /https:\/\/app\.contentful\.com\/spaces\/[^/\s)]+\/entries\/[^/\s)]+/g;
  const matches = text.match(linkRegex) ?? [];
  return [...new Set(matches)];
}

function buildSystemPrompt(
  executionMode: "plan" | "execute",
  orchestrationContext?: string
): string {
  const phaseInstruction =
    executionMode === "execute"
      ? "Execution mode is ENABLED. You may perform approved mutating actions now."
      : "Planning mode is ENABLED. You MUST only inspect/analyze and prepare a plan. Do not perform mutating actions or claim anything was created/updated/published.";

  return `You are a Contentful content management assistant in Slack.
Create high-quality, schema-aligned campaigns using the content types available in the connected space.

Before planning or execution:
- Inspect all available tools.
- Deeply review relevant content types and field definitions.
- Adapt to granted capabilities at runtime.

Response style:
- Be concise, scannable, and focused on new information.
- Do not repeat prior context unless needed.
- Do not provide field-by-field dumps unless explicitly requested.

Mode rules:
- For straightforward questions, read and answer immediately.
- For content/campaign creation, use a strict 2-step flow:
  1) Plan: high-level creative direction + essential creative clarifications only.
  2) Execute: once enabled, execute full approved scope and return a concise summary.

Campaign planning contract:
- Initial planning response must contain only:
  - Section 1: Campaign Concept
  - Section 2: Clarifying Questions
- Do not include execution mechanics, schema constraints, assumptions, entry counts, risks/rollback, batching notes, or "ready to execute" language in that initial response.
- Ask clarifying questions once only. After user reply, treat it as final direction and proceed to execution unless blocked by a hard error.
- Keep planning focused on creative direction, not implementation details.

Execution rules:
- Complete the full requested scope in the execution run unless a hard blocker occurs.
- Internal batching is allowed for reliability, but never mention batching or batch limits to users.
- If some clarifications are unanswered, proceed with informed defaults and briefly state assumptions.
- If language/locale is unspecified or locale permissions are unavailable, use the space default locale without asking for locale confirmation.
- Check stable identifiers for idempotency before creating new entries/assets.
- Infer permissions from currently available tools before acting. If publish capability is unavailable, do not attempt publish calls; create all requested content as drafts and continue.
- Execution completeness is mandatory: create every requested deliverable and required referenced content (for example, hero/section/CTA components and linked blog/page content when the model requires those references), unless blocked by a hard error.
- Preferred operation order: create/update all requested draft content first, then publish as a final step only when publish capability is available.

Quality and follow-up:
- For campaigns, be creative and complete: strong positioning, audience-aware angles, and non-repetitive CTA framing.
- If a hard blocker occurs, stop and provide resumable status. Non-blocking publish failures should not prevent completing draft creation for remaining requested items.
- After execution, provide high-level created/updated summary and entry links in this format: https://app.contentful.com/spaces/{spaceId}/entries/{entryId}
- Do not include full entry payloads in chat responses.
- Expect post-execution iteration: edits, expansions, and refinements are normal continuation work.

Current phase:
${phaseInstruction}
${orchestrationContext ? `\nCurrent orchestration context:\n${orchestrationContext}` : ""}`;
}

type ToolAccessClassification = "read" | "write" | "unknown";

function getToolCapabilityText(tool: unknown): string {
  if (!tool || typeof tool !== "object") return "";
  const candidate = tool as {
    title?: unknown;
    description?: unknown;
    _meta?: unknown;
    inputSchema?: unknown;
  };
  return [
    typeof candidate.title === "string" ? candidate.title : "",
    typeof candidate.description === "string" ? candidate.description : "",
    candidate._meta ? JSON.stringify(candidate._meta) : "",
    candidate.inputSchema ? JSON.stringify(candidate.inputSchema) : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function classifyToolAccess(tool: unknown): ToolAccessClassification {
  const text = getToolCapabilityText(tool);
  if (!text) return "unknown";

  const writeSignals = [
    "create",
    "update",
    "delete",
    "remove",
    "publish",
    "unpublish",
    "archive",
    "unarchive",
    "mutat",
    "write",
    "upsert",
    "patch",
  ];

  const readSignals = [
    "read",
    "list",
    "get",
    "query",
    "search",
    "find",
    "inspect",
    "retrieve",
    "lookup",
    "fetch",
    "browse",
    "view",
  ];

  if (writeSignals.some((signal) => text.includes(signal))) return "write";
  if (readSignals.some((signal) => text.includes(signal))) return "read";
  return "unknown";
}

function hasPublishCapability(tools: Record<string, unknown>): boolean {
  return Object.entries(tools).some(([toolName, tool]) => {
    const combined = `${toolName} ${getToolCapabilityText(tool)}`.toLowerCase();
    return /\bpublish\b|publish_entry|publishasset|publish_asset/.test(combined);
  });
}

function buildToolCapabilitySummary(
  tools: Record<string, unknown>,
  executionMode: "plan" | "execute"
): {
  executionMode: "plan" | "execute";
  totalTools: number;
  readTools: number;
  writeTools: number;
  unknownTools: number;
  hasPublishCapability: boolean;
  toolNames: string[];
} {
  let readTools = 0;
  let writeTools = 0;
  let unknownTools = 0;

  for (const tool of Object.values(tools)) {
    const access = classifyToolAccess(tool);
    if (access === "read") readTools += 1;
    else if (access === "write") writeTools += 1;
    else unknownTools += 1;
  }

  return {
    executionMode,
    totalTools: Object.keys(tools).length,
    readTools,
    writeTools,
    unknownTools,
    hasPublishCapability: hasPublishCapability(tools),
    toolNames: Object.keys(tools).slice(0, 50),
  };
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
    slackUserId?: string;
    executionMode?: "plan" | "execute";
  }
): Promise<AsyncIterable<string>> {
  const redis = getRedis();
  const slackUserId = options?.slackUserId;
  const executionMode = options?.executionMode ?? "plan";
  const messageHash = hashMessage(userMessage);
  const responseKey = getIdempotencyResponseKey(threadId, messageHash);
  const lockKey = getIdempotencyLockKey(threadId, messageHash);

  // Load token, history, campaign state, and idempotency cache concurrently.
  const [rawToken, history, existingCampaignJob, cachedResponse] = await Promise.all([
    getStoredToken(redis, slackUserId),
    loadHistory(redis, threadId),
    loadCampaignJob(redis, threadId),
    redis.get(responseKey),
  ]);

  if (cachedResponse) {
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
    await redis.quit();
    return singleMessageStream(
      "This request is already running. Reply with `continue` in this thread to resume after the current run completes."
    );
  }

  // Refresh the token if it's close to expiry.
  const token = await refreshTokenIfNeeded(redis, rawToken, slackUserId);
  const isCampaign =
    detectCampaignIntent(userMessage) ||
    (existingCampaignJob !== null && existingCampaignJob.status !== "completed");

  let campaignJob: CampaignJobState | null = null;
  if (isCampaign) {
    const now = Date.now();
    campaignJob = existingCampaignJob ?? {
      jobId: randomUUID(),
      threadId,
      status: "running",
      phase: "planning",
      attempts: 0,
      startedAt: now,
      updatedAt: now,
      lastMessageHash: messageHash,
      idempotencyKey: lockKey,
      createdEntryLinks: [],
      plan: buildExecutionPlan(userMessage),
    };

    campaignJob = {
      ...campaignJob,
      status: "running",
      phase: executionMode === "execute" ? "executing" : "planning",
      attempts: campaignJob.attempts + 1,
      updatedAt: now,
      lastMessageHash: messageHash,
      idempotencyKey: lockKey,
      lastError: undefined,
    };
    await saveCampaignJob(redis, campaignJob);
  }

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
  const activeTools =
    executionMode === "execute"
      ? tools
      : Object.fromEntries(
          // Planning mode is fail-closed: only include tools we can classify as read-only.
          Object.entries(tools).filter(([, tool]) => classifyToolAccess(tool) === "read")
        );

  const orchestrationContext = campaignJob
    ? JSON.stringify(
        {
          campaignJobId: campaignJob.jobId,
          status: campaignJob.status,
          phase: campaignJob.phase,
          attempts: campaignJob.attempts,
          createdEntryLinks: campaignJob.createdEntryLinks,
          plan: campaignJob.plan,
          toolCapabilitySummary: buildToolCapabilitySummary(tools, executionMode),
        },
        null,
        2
      )
    : JSON.stringify(
        {
          toolCapabilitySummary: buildToolCapabilitySummary(tools, executionMode),
        },
        null,
        2
      );

  const result = streamText({
    model: openai("gpt-5"),
    system: buildSystemPrompt(executionMode, orchestrationContext),
    messages: updatedHistory,
    tools: activeTools,
    stopWhen: stepCountIs(getStepCap(isCampaign, executionMode)),
    onFinish: async ({ response }) => {
      try {
        const newMessages = response.messages as ModelMessage[];
        const responseText = responseMessagesToText(newMessages);
        const createdLinks = extractCreatedEntryLinks(responseText);

        await saveHistory(redis, threadId, [...updatedHistory, ...newMessages]);
        await redis.set(responseKey, responseText, "EX", IDEMPOTENCY_TTL_SECONDS);

        if (campaignJob) {
          const mergedLinks = [
            ...new Set([...campaignJob.createdEntryLinks, ...createdLinks]),
          ];

          await saveCampaignJob(redis, {
            ...campaignJob,
            status: executionMode === "execute" ? "completed" : "running",
            phase:
              executionMode === "execute"
                ? "completed"
                : "ready_for_execution",
            updatedAt: Date.now(),
            createdEntryLinks: mergedLinks,
          });
        }
      } finally {
        await redis.del(lockKey);
        await mcpClient.close();
        await redis.quit();
      }
    },
  });

  return (async function* () {
    try {
      for await (const chunk of result.textStream) {
        yield chunk;
      }
    } catch (error) {
      if (campaignJob) {
        await saveCampaignJob(redis, {
          ...campaignJob,
          status: "failed",
          phase: executionMode === "execute" ? "executing" : "planning",
          updatedAt: Date.now(),
          lastError: error instanceof Error ? error.message : "Unknown error",
        });
      }
      await redis.del(lockKey);
      await mcpClient.close();
      await redis.quit();
      throw error;
    }
  })();
}
