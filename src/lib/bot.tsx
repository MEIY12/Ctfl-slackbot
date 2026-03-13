/** @jsxImportSource chat */
import {
  Actions,
  Card,
  CardText,
  Chat,
  Divider,
  LinkButton,
  Section,
  emoji,
  type CardElement,
  type Thread,
} from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";
import Redis from "ioredis";
import { classifyPendingIntent, runAgent, NotConnectedError } from "./agent";
import { getConnectUrl, getStoredToken, refreshTokenIfNeeded } from "./auth";

const PENDING_TTL_MS = 1000 * 60 * 60 * 24;
const EXECUTION_ACK_MESSAGE = "Confirmed - executing now.";
const MAX_SHOWCASE_ENTRIES = 6;
const ENTRY_LINK_REGEX =
  /https:\/\/app\.contentful\.com\/spaces\/[^/\s)]+\/entries\/[^/\s)]+/g;

type PendingApproval = {
  threadId: string;
  originalMessageId: string;
  pendingUserId?: string;
};

export const bot = new Chat({
  userName: "contentful-bot",
  adapters: {
    slack: createSlackAdapter(),
  },
  state: createRedisState(),
});

function notConnectedMessage(slackUserId?: string): string {
  const base = getConnectUrl();
  const connectUrl = slackUserId
    ? `${base}?uid=${encodeURIComponent(slackUserId)}`
    : base;
  return (
    `*Contentful isn't connected yet.* ` +
    `An admin needs to authorize this bot before it can manage content.\n\n` +
    `*<${connectUrl}|Connect to Contentful →>*`
  );
}

function pendingMessageKey(messageId: string): string {
  return `pending:${messageId}`;
}

function pendingThreadKey(threadId: string, userId?: string): string {
  return `pending-thread:${threadId}:${userId ?? "any"}`;
}

function pendingThreadIndexKey(threadId: string, userId?: string): string {
  return `pending-thread-index:${threadId}:${userId ?? "any"}`;
}

async function getPendingIndex(threadId: string, userId?: string): Promise<string[]> {
  const state = bot.getState();
  const existing = await state.get<string[]>(pendingThreadIndexKey(threadId, userId));
  return Array.isArray(existing) ? existing.filter((item) => typeof item === "string") : [];
}

async function addPendingIndexEntry(
  threadId: string,
  pendingMessageId: string,
  userId?: string
): Promise<void> {
  const state = bot.getState();
  const current = await getPendingIndex(threadId, userId);
  const next = [...current.filter((id) => id !== pendingMessageId), pendingMessageId];
  await state.set(pendingThreadIndexKey(threadId, userId), next, PENDING_TTL_MS);
}

async function removePendingIndexEntry(
  threadId: string,
  pendingMessageId: string,
  userId?: string
): Promise<void> {
  const state = bot.getState();
  const current = await getPendingIndex(threadId, userId);
  const next = current.filter((id) => id !== pendingMessageId);
  if (next.length === 0) {
    await state.delete(pendingThreadIndexKey(threadId, userId));
    return;
  }
  await state.set(pendingThreadIndexKey(threadId, userId), next, PENDING_TTL_MS);
}

async function resolvePendingMessageId(threadId: string, userId?: string): Promise<string | null> {
  const state = bot.getState();
  const scopes: Array<{ threadId: string; userId?: string }> = [
    { threadId, userId },
    { threadId },
  ];

  for (const scope of scopes) {
    const ids = await getPendingIndex(scope.threadId, scope.userId);
    for (let idx = ids.length - 1; idx >= 0; idx -= 1) {
      const pendingMessageId = ids[idx];
      if (!pendingMessageId) continue;
      const pending = await state.get<PendingApproval>(pendingMessageKey(pendingMessageId));
      if (pending) return pendingMessageId;
      await removePendingIndexEntry(scope.threadId, pendingMessageId, scope.userId);
    }
  }

  return null;
}

function truncateLabel(value: string, maxLength = 90): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function extractCreatedEntryItems(summaryText: string): Array<{ label: string; url: string }> {
  const lines = summaryText.split(/\r?\n/);
  const sectionLines: string[] = [];
  let inCreatedOrUpdated = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const normalizedHeading = line
      .toLowerCase()
      .replace(/^[#\-\*\d\.\)\s]+/, "")
      .replace(/[:\-]+$/, "")
      .trim();

    if (
      normalizedHeading === "created/updated" ||
      normalizedHeading === "created updated" ||
      normalizedHeading === "created-updated"
    ) {
      inCreatedOrUpdated = true;
      continue;
    }

    if (
      inCreatedOrUpdated &&
      (normalizedHeading === "outcome" ||
        normalizedHeading === "verification" ||
        normalizedHeading === "blockers")
    ) {
      break;
    }

    if (inCreatedOrUpdated) {
      sectionLines.push(line);
    }
  }

  const sourceLines = sectionLines.length > 0 ? sectionLines : lines;
  const results: Array<{ label: string; url: string }> = [];
  const seen = new Set<string>();

  for (const line of sourceLines) {
    const urls = line.match(ENTRY_LINK_REGEX) ?? [];
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);

      const markdownLinkMatch = line.match(
        /\[([^\]]+)\]\((https:\/\/app\.contentful\.com\/spaces\/[^/\s)]+\/entries\/[^/\s)]+)\)/
      );
      const slackLinkMatch = line.match(
        /<(https:\/\/app\.contentful\.com\/spaces\/[^|>]+\/entries\/[^|>]+)\|([^>]+)>/
      );

      let label = "";
      if (markdownLinkMatch && markdownLinkMatch[2] === url) {
        label = markdownLinkMatch[1] ?? "";
      } else if (slackLinkMatch && slackLinkMatch[1] === url) {
        label = slackLinkMatch[2] ?? "";
      } else {
        const urlIndex = line.indexOf(url);
        if (urlIndex > 0) {
          label = line.slice(0, urlIndex);
        }
      }

      const fallbackLabel = "Created entry";
      const cleaned = label
        .replace(/^[\-\*\u2022]\s*/, "")
        .replace(/^\d+[\.\)]\s*/, "")
        .replace(/[:\-\u2014]\s*$/, "")
        .trim();

      results.push({ label: truncateLabel(cleaned || fallbackLabel), url });
    }
  }

  return results;
}

type ResolvedEntryMeta = {
  contentTypeId?: string;
  title?: string;
  preview?: string;
};

function parseEntryRefFromUrl(url: string): { spaceId: string; entryId: string } | null {
  const match = url.match(/\/spaces\/([^/]+)\/entries\/([^/?#]+)/);
  if (!match) return null;
  return { spaceId: match[1], entryId: match[2] };
}

function pickEntryTitle(fields: unknown): string | null {
  if (!fields || typeof fields !== "object") return null;
  const record = fields as Record<string, unknown>;
  const preferredKeys = ["title", "name", "internalName", "headline"];

  for (const key of preferredKeys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const localizedValues = Object.values(value as Record<string, unknown>);
      const firstString = localizedValues.find(
        (candidate) => typeof candidate === "string" && candidate.trim()
      );
      if (typeof firstString === "string") return firstString.trim();
    }
  }

  for (const value of Object.values(record)) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const localizedValues = Object.values(value as Record<string, unknown>);
      const firstString = localizedValues.find(
        (candidate) => typeof candidate === "string" && candidate.trim()
      );
      if (typeof firstString === "string") return firstString.trim();
    }
  }

  return null;
}

function collectRichTextNodeText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const record = node as Record<string, unknown>;
  if (typeof record.value === "string") return record.value;
  const content = Array.isArray(record.content) ? record.content : [];
  return content.map((child) => collectRichTextNodeText(child)).join(" ");
}

function fieldValueToText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const joined = value
      .map((item) => fieldValueToText(item))
      .filter((item): item is string => Boolean(item))
      .join(", ");
    return joined.trim() || null;
  }
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  if (record.nodeType === "document") {
    const richText = collectRichTextNodeText(record).replace(/\s+/g, " ").trim();
    return richText || null;
  }

  const localizedValues = Object.values(record)
    .map((item) => fieldValueToText(item))
    .filter((item): item is string => Boolean(item));
  if (localizedValues.length > 0) return localizedValues[0];
  return null;
}

function pickEntryPreview(fields: unknown, title?: string): string | null {
  if (!fields || typeof fields !== "object") return null;
  const record = fields as Record<string, unknown>;
  const preferredKeys = ["summary", "description", "excerpt", "dek", "body", "content"];

  for (const key of preferredKeys) {
    const preview = fieldValueToText(record[key]);
    if (preview && preview !== title) return preview;
  }

  for (const [key, value] of Object.entries(record)) {
    if (["title", "name", "internalName", "headline"].includes(key)) continue;
    const preview = fieldValueToText(value);
    if (preview && preview !== title) return preview;
  }

  return null;
}

async function loadEntryMetadataForUrls(
  urls: string[],
  slackUserId?: string
): Promise<Map<string, ResolvedEntryMeta>> {
  const metadata = new Map<string, ResolvedEntryMeta>();
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl || urls.length === 0) return metadata;

  const redis = new Redis(redisUrl);
  try {
    const storedToken = await getStoredToken(redis, slackUserId);
    if (!storedToken) return metadata;
    const token = await refreshTokenIfNeeded(redis, storedToken, slackUserId);

    await Promise.all(
      urls.map(async (url) => {
        const ref = parseEntryRefFromUrl(url);
        if (!ref) return;

        try {
          const response = await fetch(
            `https://api.contentful.com/spaces/${ref.spaceId}/entries/${ref.entryId}`,
            {
              headers: {
                Authorization: `Bearer ${token.accessToken}`,
              },
            }
          );
          if (!response.ok) return;

          const json = (await response.json()) as {
            fields?: unknown;
            sys?: { contentType?: { sys?: { id?: string } } };
          };
          const contentTypeId = json.sys?.contentType?.sys?.id;
          const title = pickEntryTitle(json.fields);
          const preview = pickEntryPreview(json.fields, title ?? undefined);

          metadata.set(url, {
            contentTypeId: typeof contentTypeId === "string" ? contentTypeId : undefined,
            title: title ?? undefined,
            preview: preview ?? undefined,
          });
        } catch {
          // Ignore individual metadata failures and keep card generation resilient.
        }
      })
    );
  } finally {
    await redis.quit();
  }

  return metadata;
}

function buildEntryDisplayLabel(
  fallbackLabel: string,
  metadata?: ResolvedEntryMeta
): string {
  if (metadata?.contentTypeId && metadata.title) {
    return `${metadata.contentTypeId}: ${metadata.title}`;
  }
  if (metadata?.title) return metadata.title;
  if (metadata?.contentTypeId) return metadata.contentTypeId;
  return fallbackLabel || "Created entry";
}

async function buildCreatedEntriesShowcaseCard(
  summaryText: string,
  slackUserId?: string
): Promise<CardElement | null> {
  const entries = extractCreatedEntryItems(summaryText);
  if (entries.length === 0) return null;

  const displayedEntries = entries.slice(0, MAX_SHOWCASE_ENTRIES);
  const overflowCount = entries.length - displayedEntries.length;
  const metadataByUrl = await loadEntryMetadataForUrls(
    displayedEntries.map((entry) => entry.url),
    slackUserId
  );
  const entrySections = displayedEntries.flatMap((entry, index) => {
    const metadata = metadataByUrl.get(entry.url);
    const resolvedLabel = buildEntryDisplayLabel(entry.label, metadata);
    const preview = metadata?.preview ? truncateLabel(metadata.preview, 180) : null;
    const sectionChildren = [
      CardText(`${index + 1}. **${truncateLabel(resolvedLabel, 110)}**`),
      ...(preview ? [CardText(`_${preview}_`)] : []),
      Actions([
        LinkButton({
          label: "Open entry",
          url: entry.url,
        }),
      ]),
    ];

    return [
      Section(sectionChildren),
      CardText(entry.url),
      ...(index < displayedEntries.length - 1 ? [Divider()] : []),
    ];
  });

  return Card({
    title: "Created Content Entries",
    subtitle: `${entries.length} created`,
    children: [
      CardText("Quick view of created entries."),
      Divider(),
      ...entrySections,
      ...(overflowCount > 0 ? [CardText(`+${overflowCount} additional entries were created.`)] : []),
    ],
  });
}

async function clearPendingApproval(
  pendingMessageId: string,
  pending: PendingApproval
): Promise<void> {
  const state = bot.getState();
  await state.delete(pendingMessageKey(pendingMessageId));
  await state.delete(pendingThreadKey(pending.threadId));
  await removePendingIndexEntry(pending.threadId, pendingMessageId);
  if (pending.pendingUserId) {
    await state.delete(pendingThreadKey(pending.threadId, pending.pendingUserId));
    await removePendingIndexEntry(pending.threadId, pendingMessageId, pending.pendingUserId);
  }
}

async function tryHandlePendingExecution(
  thread: Thread<unknown, unknown>,
  messageText: string | undefined,
  userId: string | undefined
): Promise<boolean> {
  if (!userId) return false;

  const state = bot.getState();
  const pendingMessageId = await resolvePendingMessageId(thread.id, userId);
  if (!pendingMessageId) return false;

  const pending = await state.get<PendingApproval>(pendingMessageKey(pendingMessageId));
  if (!pending) {
    await state.delete(pendingThreadKey(thread.id));
    await removePendingIndexEntry(thread.id, pendingMessageId);
    await removePendingIndexEntry(thread.id, pendingMessageId, userId);
    return false;
  }

  if (pending.pendingUserId && pending.pendingUserId !== userId) {
    const targetUser = thread.mentionUser(pending.pendingUserId);
    await thread.post(`Only ${targetUser} can approve or cancel this action.`);
    return true;
  }

  const intent = await classifyPendingIntent(messageText ?? "");
  if (intent === "cancel") {
    await clearPendingApproval(pendingMessageId, pending);
    await thread.post("Understood — cancelled. Share updates anytime when you're ready.");
    return true;
  }

  if (intent !== "approve") return false;

  await clearPendingApproval(pendingMessageId, pending);
  await thread.post(EXECUTION_ACK_MESSAGE);

  void runAgentAndAwaitConfirmation(
    thread,
    (messageText ?? "").trim() || "Please continue.",
    pending.originalMessageId,
    pending.pendingUserId,
    pending.threadId,
    "execute",
    `approval:${pendingMessageId}`
  );
  return true;
}

// Run the agent, post its response, then store the bot's response message
// as the pending target so the user can ✅/❌ react to it.
//
// historyThreadId: when provided (reaction context), use this for agent history
// instead of thread.id, and collect the stream to text before posting because
// reaction event threads have no _currentMessage and cannot stream.
async function runAgentAndAwaitConfirmation(
  thread: Thread<unknown, unknown>,
  userText: string,
  originalMessageId: string,
  slackUserId?: string,
  historyThreadId?: string,
  executionMode: "plan" | "execute" = "plan",
  requestScopeId?: string
): Promise<void> {
  const agentThreadId = historyThreadId ?? thread.id;
  try {
    const textStream = await runAgent(agentThreadId, userText, {
      slackUserId,
      executionMode,
      requestScopeId,
    });

    const chunks: string[] = [];
    const captureStream = async function* (): AsyncIterable<string> {
      for await (const chunk of textStream) {
        chunks.push(chunk);
        yield chunk;
      }
    };

    let sent;
    if (historyThreadId) {
      // Reaction context: no _currentMessage on thread, streaming crashes.
      // Collect full text first, then post as markdown.
      for await (const chunk of textStream) {
        chunks.push(chunk);
      }
      sent = await thread.post({ markdown: chunks.join("") });
    } else {
      // Message context: _currentMessage is set, streaming works fine.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sent = await thread.post(captureStream() as any);
    }
    const fullText = chunks.join("");

    if (executionMode === "plan") {
      const pending: PendingApproval = {
        threadId: agentThreadId,
        originalMessageId,
        pendingUserId: slackUserId,
      };
      await bot.getState().set(pendingMessageKey(sent.id), pending, PENDING_TTL_MS);
      await bot.getState().set(pendingThreadKey(agentThreadId), sent.id, PENDING_TTL_MS);
      await addPendingIndexEntry(agentThreadId, sent.id);
      if (slackUserId) {
        await bot.getState().set(
          pendingThreadKey(agentThreadId, slackUserId),
          sent.id,
          PENDING_TTL_MS
        );
        await addPendingIndexEntry(agentThreadId, sent.id, slackUserId);
      }
    }

    if (executionMode === "execute" && thread.adapter.name === "slack") {
      const showcaseCard = await buildCreatedEntriesShowcaseCard(fullText, slackUserId);
      if (showcaseCard) {
        await thread.post({
          card: showcaseCard,
          fallbackText: "Created content entries are available in the card above.",
        });
      }
    }
  } catch (err) {
    if (err instanceof NotConnectedError) {
      await thread.post(notConnectedMessage(slackUserId));
      return;
    }
    console.error("[contentful-bot] agent error:", err);
    await thread.post(
      "Sorry, I ran into an error while processing your request. Please try again."
    );
  }
}

// When a user @mentions the bot, react with eyes, run the agent, then wait for confirmation
bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await thread.adapter.addReaction(thread.id, message.id, emoji.eyes);
  void runAgentAndAwaitConfirmation(
    thread,
    message.text ?? "",
    message.id,
    message.author?.userId,
    undefined,
    "plan",
    `message:${message.id}:plan`
  );
});

// When a user replies in a subscribed thread, same flow
bot.onSubscribedMessage(async (thread, message) => {
  await thread.adapter.addReaction(thread.id, message.id, emoji.eyes);
  const handledApproval = await tryHandlePendingExecution(
    thread,
    message.text ?? "",
    message.author?.userId
  );
  if (handledApproval) return;
  void runAgentAndAwaitConfirmation(
    thread,
    message.text ?? "",
    message.id,
    message.author?.userId,
    undefined,
    "plan",
    `message:${message.id}:plan`
  );
});

// Handle ✅ (proceed) and ❌ (cancel) reactions on bot responses
bot.onReaction(["check", "x"], async (event) => {
  if (!event.added) return;
  if (event.user.isMe) return;

  // Look up pending data by message ID — avoids thread ID mismatch between
  // where state was stored and the thread ID the reaction event carries.
  const pending = await bot.getState().get<PendingApproval>(pendingMessageKey(event.messageId));

  if (!pending) return;

  const { threadId, originalMessageId, pendingUserId } = pending;

  if (pendingUserId && event.user.userId !== pendingUserId) {
    const targetUser = event.thread.mentionUser(pendingUserId);
    await event.thread
      .postEphemeral(
        event.user,
        `Only ${targetUser} can approve or cancel this action.`,
        { fallbackToDM: false }
      )
      .catch(() => undefined);
    return;
  }

  // Clear pending state regardless of outcome
  await clearPendingApproval(event.messageId, pending);

  if (event.emoji === emoji.x) {
    // User cancelled — remove the eyes from the original user message
    await event.adapter.removeReaction(threadId, originalMessageId, emoji.eyes);
    return;
  }

  await event.thread.post(EXECUTION_ACK_MESSAGE);

  // Continue the conversation — pass pending.threadId so agent uses correct
  // history and post is non-streaming (reaction threads have no _currentMessage)
  void runAgentAndAwaitConfirmation(
    event.thread,
    "Yes, please proceed.",
    originalMessageId,
    pendingUserId,
    pending.threadId,
    "execute",
    `approval:${event.messageId}`
  );
});
