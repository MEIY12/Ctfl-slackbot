import { createMCPClient } from "@ai-sdk/mcp";
import { openai } from "@ai-sdk/openai";
import { generateText, streamText, stepCountIs, type ModelMessage } from "ai";
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

export function detectHighCompositionRequest(userMessage: string): boolean {
  return /\b(all\s+related|related\s+entries|linked\s+dependencies|dependencies|end[- ]to[- ]end|full\s+build|complete\s+build|full\s+set|complete\s+set|holistic|multi[- ](part|step|entry|item|section|component))\b/i.test(
    userMessage
  );
}

export function inferExpectedCompositionDepth(userMessage: string): {
  kind: "high" | "bounded";
  minimumComponents: number;
} {
  if (detectHighCompositionRequest(userMessage)) {
    return { kind: "high", minimumComponents: 5 };
  }

  return { kind: "bounded", minimumComponents: 2 };
}

export function formatExecutionSummary(input: {
  outcome: string[];
  createdOrUpdated: string[];
  verification: string[];
  blockers?: string[];
}): string {
  const toBullets = (items: string[]): string[] =>
    items.map((item) => item.trim()).filter(Boolean).map((item) => `- ${item}`);

  const sections = [
    ["Outcome:", toBullets(input.outcome)],
    ["Created/Updated:", toBullets(input.createdOrUpdated)],
    ["Verification:", toBullets(input.verification)],
  ] as const;

  const blockers = toBullets(input.blockers ?? []);
  if (blockers.length > 0) {
    return [
      ...sections.flatMap(([title, lines]) => [title, ...lines]),
      "Blockers:",
      ...blockers,
    ].join("\n");
  }

  return sections.flatMap(([title, lines]) => [title, ...lines]).join("\n");
}

type SummarySectionKey =
  | "outcome"
  | "createdOrUpdated"
  | "verification"
  | "blockers";

function canonicalizeSummaryHeading(line: string): SummarySectionKey | null {
  const normalized = line
    .trim()
    .toLowerCase()
    .replace(/^[#\-\*\d\.\)\s]+/, "")
    .replace(/[:\-]+$/, "");

  if (normalized === "outcome") {
    return "outcome";
  }
  if (
    normalized === "created/updated" ||
    normalized === "created-updated" ||
    normalized === "created updated"
  ) {
    return "createdOrUpdated";
  }
  if (normalized === "verification") {
    return "verification";
  }
  if (normalized === "blockers") {
    return "blockers";
  }
  return null;
}

function parseSummaryLineItem(line: string): string {
  return line
    .trim()
    .replace(/^[\-\*\u2022]\s+/, "")
    .replace(/^\d+[\.\)]\s+/, "")
    .trim();
}

function parseExecutionSummarySections(text: string): {
  outcome: string[];
  createdOrUpdated: string[];
  verification: string[];
  blockers: string[];
} {
  const sections: Record<SummarySectionKey, string[]> = {
    outcome: [],
    createdOrUpdated: [],
    verification: [],
    blockers: [],
  };
  let currentSection: SummarySectionKey | null = null;

  const lines = text.split(/\r?\n/).map((line) => line.trimEnd());
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const heading = canonicalizeSummaryHeading(line);
    if (heading) {
      currentSection = heading;
      continue;
    }

    if (!currentSection) continue;
    const item = parseSummaryLineItem(line);
    if (item) sections[currentSection].push(item);
  }

  return sections;
}

function getMissingRequiredSummarySections(sections: {
  outcome: string[];
  createdOrUpdated: string[];
  verification: string[];
}): string[] {
  const missing: string[] = [];
  if (sections.outcome.length === 0) missing.push("Outcome");
  if (sections.createdOrUpdated.length === 0) missing.push("Created/Updated");
  if (sections.verification.length === 0) missing.push("Verification");
  return missing;
}

export function normalizeExecutionSummaryText(text: string): string {
  const parsed = parseExecutionSummarySections(text);
  if (getMissingRequiredSummarySections(parsed).length > 0) return text;

  return formatExecutionSummary({
    outcome: parsed.outcome,
    createdOrUpdated: parsed.createdOrUpdated,
    verification: parsed.verification,
    blockers: parsed.blockers,
  });
}

export type CompletionGateInput = {
  executionMode: "plan" | "execute";
  isHighCompositionRequest: boolean;
  requiredReferencesSatisfied: boolean;
  expectedCompositionDepthMet: boolean;
  completionEvidence: string[];
};

export type CompletionGateResult = {
  pass: boolean;
  needsRepair: boolean;
  missingPieces: string[];
};

export type SingleRepairPassInput = {
  initialText: string;
  evaluateFromText: (text: string) => CompletionGateResult;
  runRepairPass: (input: {
    repairPrompt: string;
    missingPieces: string[];
  }) => Promise<string>;
  buildRepairPrompt: (missingPieces: string[]) => string;
  buildBlockerResponse: (missingPieces: string[]) => string;
};

export type SingleRepairPassResult = {
  finalText: string;
  finalGateResult: CompletionGateResult;
};

export function evaluateCompletionGate(
  input: CompletionGateInput
): CompletionGateResult {
  if (input.executionMode !== "execute") {
    return { pass: true, needsRepair: false, missingPieces: [] };
  }

  const missingPieces: string[] = [];

  if (input.isHighCompositionRequest && input.completionEvidence.length === 0) {
    missingPieces.push("completion evidence");
  }
  if (!input.requiredReferencesSatisfied) {
    missingPieces.push("required references");
  }
  if (input.isHighCompositionRequest && !input.expectedCompositionDepthMet) {
    missingPieces.push("expected composition depth");
  }

  return {
    pass: missingPieces.length === 0,
    needsRepair: missingPieces.length > 0,
    missingPieces,
  };
}

export async function runCompletionGateWithSingleRepairPass(
  input: SingleRepairPassInput
): Promise<SingleRepairPassResult> {
  let finalText = input.initialText;
  let finalGateResult = input.evaluateFromText(finalText);

  if (finalGateResult.needsRepair) {
    const repairPrompt = input.buildRepairPrompt(finalGateResult.missingPieces);
    finalText = await input.runRepairPass({
      repairPrompt,
      missingPieces: finalGateResult.missingPieces,
    });
    finalGateResult = input.evaluateFromText(finalText);

    if (!finalGateResult.pass) {
      finalText = input.buildBlockerResponse(finalGateResult.missingPieces);
    }
  }

  return { finalText, finalGateResult };
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

function collectCompletionEvidence(text: string, createdLinks: string[]): string[] {
  const evidence: string[] = [];

  if (createdLinks.length > 0) {
    evidence.push(`${createdLinks.length} entry link(s) captured`);
  }

  if (/\b(created|updated|published|executed|completed|done)\b/i.test(text)) {
    evidence.push("assistant reported completion status");
  }

  return evidence;
}

function buildCompletenessRepairPrompt(missingPieces: string[]): string {
  return [
    "Repair pass: your prior execution response failed the completeness gate.",
    `Missing pieces: ${missingPieces.join(", ")}.`,
    "Provide one concise final response that resolves these gaps.",
    "If any gap cannot be resolved, state a blocker and list the missing pieces.",
  ].join(" ");
}

function buildCompletenessBlockerResponse(missingPieces: string[]): string {
  return `Blocked: unable to complete request after one repair pass. Missing pieces: ${missingPieces.join(", ")}.`;
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

export function buildSystemPrompt(
  executionMode: "plan" | "execute",
  orchestrationContext?: string
): string {
  const phaseInstruction =
    executionMode === "execute"
      ? "Execution mode is ENABLED. You may perform approved mutating actions now."
      : "Planning mode is ENABLED. You MUST only inspect/analyze and prepare a plan. Do not perform mutating actions or claim anything was created/updated/published.";

  return `You are a Contentful content management assistant in Slack.
Create high-quality, schema-aligned content using the connected space content model.

Before planning or execution:
- Inspect available tools.
- Review relevant content types and required fields.
- Adapt to granted capabilities at runtime.
- Support any content model discovered at runtime; never assume fixed content type names or fixed relationship shapes.
- If a user question or execution step depends on existing Contentful data (for example: content type IDs, entry IDs, linked references, slug lookups), resolve it by querying MCP tools and inspecting existing content structure before asking the user.
- Prefer evidence from the space (content model + existing entries/assets) over asking follow-up questions.
- Make reasonable assumptions from discovered naming/content patterns when exact matches are missing, and clearly mark those assumptions as inferred.
- Ask the user only when MCP/content-structure lookup cannot produce a reliable answer.

Response style (always):
- Be very concise and to the point.
- Keep responses short; default to brief bullets.
- Do not repeat context, dump fields, or explain internal mechanics unless asked.
- Do not include extra sections such as long assumptions, rationale, or next-step menus unless the user requests them.
- Slack supports Markdown output. Prefer concise Markdown that renders cleanly in Slack:
  - Use short headings, bullets, inline code, and inline links when helpful.
  - Avoid HTML and deeply nested or decorative formatting.
  - Keep code fences short and only include them when the user asks for code.

Mode rules:
- Straightforward questions: answer directly and briefly.
- Structured content requests: strict 2-step flow:
  1) Plan
  2) Execute

Planning contract:
- Initial planning response must contain exactly 2 sections:
  - Section 1: Proposed Content Strategy (max 3 bullets)
  - Section 2: Clarifying Questions (max 3 questions)
- Ask clarifying questions only once. After user reply, treat it as final direction and proceed unless blocked by a hard error.
- Keep planning focused on creative direction only.

Execution rules:
- Complete full requested scope unless a hard blocker occurs.
- Infer and create both required and expected related content from model relationships when fulfilling the request.
- Treat user intent as outcome-focused; infer the right composition depth from discovered schema constraints, references, and existing content patterns.
- For high-composition asks, do not stop at minimal schema satisfaction; deliver the full composed outcome implied by the request.
- Check stable identifiers for idempotency before creating new entries/assets.
- Infer permissions from available tools. If publish is unavailable, create drafts and continue.
- Use the space default locale when locale is unspecified or locale permissions are unavailable.
- Create/update drafts first, then publish only if capability exists.

Execution summary format (final):
- Keep it short and scannable.
- Use only these sections:
  1) Outcome
  2) Created/Updated
  3) Verification
  4) Blockers
- Final summary structure must be deterministic and concise, and aligned exactly to these formatter sections.
- Include only high-level counts and entry links in this format: https://app.contentful.com/spaces/{spaceId}/entries/{entryId}
- No component-by-component deep breakdown, long notes/assumptions, or next-step suggestions unless explicitly requested.

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

export type PendingIntent = "approve" | "cancel" | "unclear";

export async function classifyPendingIntent(messageText: string): Promise<PendingIntent> {
  const trimmed = messageText.trim();
  if (!trimmed) return "unclear";

  try {
    const result = await generateText({
      model: openai("gpt-5-mini"),
      temperature: 0,
      maxOutputTokens: 8,
      system:
        "You classify whether a user message is an approval to proceed, a cancellation, or unclear. " +
        "Respond with exactly one lowercase word: approve, cancel, or unclear.",
      prompt: `Message:\n"""${trimmed}"""`,
    });

    const normalized = result.text.trim().toLowerCase();
    if (normalized === "approve") return "approve";
    if (normalized === "cancel") return "cancel";
    return "unclear";
  } catch {
    return "unclear";
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
    requestScopeId?: string;
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
  const slackUserId = options?.slackUserId;
  const executionMode = options?.executionMode ?? "plan";
  const requestScopeId = options?.requestScopeId;
  const isHighCompositionRequest = detectHighCompositionRequest(userMessage);
  const expectedCompositionDepth = inferExpectedCompositionDepth(userMessage);
  const messageHash = hashMessage(
    `${executionMode}\n${requestScopeId ?? "default"}\n${userMessage}`
  );
  const responseKey = getIdempotencyResponseKey(threadId, messageHash);
  const lockKey = getIdempotencyLockKey(threadId, messageHash);
  trace("run:start", {
    threadId,
    executionMode,
    requestScopeId: requestScopeId ?? null,
    hasSlackUserId: Boolean(slackUserId),
    isHighCompositionRequest,
    expectedCompositionDepth,
  });

  // Load token, history, campaign state, and idempotency cache concurrently.
  const [rawToken, history, existingCampaignJob, cachedResponse] = await Promise.all([
    getStoredToken(redis, slackUserId),
    loadHistory(redis, threadId),
    loadCampaignJob(redis, threadId),
    redis.get(responseKey),
  ]);
  trace("run:loaded-state", {
    historyCount: history.length,
    hasToken: Boolean(rawToken),
    hasExistingCampaignJob: Boolean(existingCampaignJob),
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
    trace("run:campaign-job-updated", {
      campaignJobId: campaignJob.jobId,
      phase: campaignJob.phase,
      attempts: campaignJob.attempts,
    });
  }

  const updatedHistory: ModelMessage[] = [
    ...history,
    { role: "user", content: userMessage },
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
    const activeTools =
      executionMode === "execute"
        ? tools
        : Object.fromEntries(
            // Planning mode is fail-closed: only include tools we can classify as read-only.
            Object.entries(tools).filter(([, tool]) => classifyToolAccess(tool) === "read")
          );
    trace("mcp:tools-loaded", {
      totalTools: Object.keys(tools).length,
      activeTools: Object.keys(activeTools).length,
      executionMode,
    });

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

    const model = openai("gpt-5-mini");
    trace("model:initial-pass:start", {
      messageCount: updatedHistory.length,
      maxSteps: getStepCap(isCampaign, executionMode),
    });
    const initialPass = await runModelPass({
      model,
      system: buildSystemPrompt(executionMode, orchestrationContext),
      messages: updatedHistory,
      tools: activeTools,
      maxSteps: getStepCap(isCampaign, executionMode),
    });
    trace("model:initial-pass:done", {
      responseChars: initialPass.text.length,
      responseMessages: initialPass.messages.length,
    });

    let finalText = initialPass.text;
    let finalMessages: ModelMessage[] = [...initialPass.messages];

    const evaluateFromText = (text: string): CompletionGateResult => {
      const createdLinks = extractCreatedEntryLinks(text);
      const completionEvidence = collectCompletionEvidence(text, createdLinks);
      const requiredReferencesSatisfied =
        !isHighCompositionRequest || createdLinks.length > 0;
      const expectedCompositionDepthMet =
        !isHighCompositionRequest ||
        createdLinks.length >= expectedCompositionDepth.minimumComponents;

      return evaluateCompletionGate({
        executionMode,
        isHighCompositionRequest,
        requiredReferencesSatisfied,
        expectedCompositionDepthMet,
        completionEvidence,
      });
    };

    const completionDecision = await runCompletionGateWithSingleRepairPass({
      initialText: finalText,
      evaluateFromText,
      runRepairPass: async ({ repairPrompt }) => {
        trace("model:repair-pass:start", { repairPromptChars: repairPrompt.length });
        const repairPass = await runModelPass({
          model,
          system: buildSystemPrompt(executionMode, orchestrationContext),
          messages: [
            ...updatedHistory,
            ...initialPass.messages,
            { role: "user", content: repairPrompt },
          ],
          tools: activeTools,
          maxSteps: Math.min(getStepCap(isCampaign, executionMode), 12),
        });

        finalMessages = [...finalMessages, ...repairPass.messages];
        trace("model:repair-pass:done", {
          responseChars: repairPass.text.length,
          responseMessages: repairPass.messages.length,
        });
        return repairPass.text;
      },
      buildRepairPrompt: buildCompletenessRepairPrompt,
      buildBlockerResponse: buildCompletenessBlockerResponse,
    });
    trace("gate:completion", {
      pass: completionDecision.finalGateResult.pass,
      needsRepair: completionDecision.finalGateResult.needsRepair,
      missingPieces: completionDecision.finalGateResult.missingPieces,
    });

    finalText = completionDecision.finalText;
    if (executionMode === "execute" && completionDecision.finalGateResult.pass) {
      finalText = normalizeExecutionSummaryText(finalText);
    }
    if (!completionDecision.finalGateResult.pass) {
      finalMessages = [...finalMessages, { role: "assistant", content: finalText }];
    }

    const finalCreatedLinks = extractCreatedEntryLinks(finalText);
    trace("run:finalize", {
      finalTextChars: finalText.length,
      createdEntryLinks: finalCreatedLinks.length,
    });
    await saveHistory(redis, threadId, [...updatedHistory, ...finalMessages]);
    await redis.set(responseKey, finalText, "EX", IDEMPOTENCY_TTL_SECONDS);

    if (campaignJob) {
      const mergedLinks = [
        ...new Set([...campaignJob.createdEntryLinks, ...finalCreatedLinks]),
      ];

      await saveCampaignJob(redis, {
        ...campaignJob,
        status: executionMode === "execute" ? "completed" : "running",
        phase: executionMode === "execute" ? "completed" : "ready_for_execution",
        updatedAt: Date.now(),
        createdEntryLinks: mergedLinks,
      });
    }

    return singleMessageStream(finalText);
  } catch (error) {
    trace("run:error", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    if (campaignJob) {
      await saveCampaignJob(redis, {
        ...campaignJob,
        status: "failed",
        phase: executionMode === "execute" ? "executing" : "planning",
        updatedAt: Date.now(),
        lastError: error instanceof Error ? error.message : "Unknown error",
      });
    }
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
