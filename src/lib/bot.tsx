/** @jsxImportSource chat */
import {
  Chat,
  Card,
  CardText,
  Actions,
  LinkButton,
  emoji,
  type Attachment,
  type Thread,
} from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";
import {
  classifyPendingIntent,
  runAgent,
  NotConnectedError,
  type FileAttachment,
} from "./agent";
import { getConnectUrl } from "./auth";
import { publishHomeTab, handleDisconnect } from "./slack-home";

const PENDING_TTL_MS = 1000 * 60 * 60 * 24;
const EXECUTION_ACK_MESSAGE = "Confirmed - executing now.";

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
  dedupeTtlMs: 600_000,
});

function notConnectedMessage(): string {
  const connectUrl = getConnectUrl();
  return (
    `*Contentful isn't connected yet.* ` +
    `An admin needs to authorize this bot before it can manage content.\n\n` +
    `*<${connectUrl}|Connect to Contentful →>*`
  );
}

const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20 MB

async function downloadAttachments(
  attachments: Attachment[] | undefined
): Promise<FileAttachment[]> {
  if (!attachments || attachments.length === 0) return [];

  const eligible = attachments
    .filter((a) => typeof a.fetchData === "function")
    .slice(0, MAX_ATTACHMENT_COUNT);

  const results = await Promise.allSettled(
    eligible.map(async (a): Promise<FileAttachment | null> => {
      try {
        const rawData = await a.fetchData!();
        const data = Buffer.isBuffer(rawData)
          ? rawData
          : Buffer.from(rawData as ArrayBuffer);
        if (data.length > MAX_ATTACHMENT_BYTES) {
          console.warn(
            `[contentful-bot] skipping oversized attachment: ${a.name ?? "unknown"} (${data.length} bytes)`
          );
          return null;
        }
        return { data, name: a.name, mimeType: a.mimeType };
      } catch (err) {
        console.warn("[contentful-bot] failed to download attachment:", a.name, err);
        return null;
      }
    })
  );

  return results
    .filter(
      (r): r is PromiseFulfilledResult<FileAttachment> =>
        r.status === "fulfilled" && r.value !== null
    )
    .map((r) => r.value);
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

  const intent = classifyPendingIntent(messageText ?? "");
  if (intent === "cancel") {
    await clearPendingApproval(pendingMessageId, pending);
    await thread.post("Understood — cancelled. Share updates anytime when you're ready.");
    return true;
  }

  if (intent !== "approve") return false;

  await clearPendingApproval(pendingMessageId, pending);
  await thread.post(EXECUTION_ACK_MESSAGE);

  await runAgentAndRespond(
    thread,
    (messageText ?? "").trim() || "Please continue.",
    pending.originalMessageId,
    pending.pendingUserId,
    pending.threadId,
    `approval:${pendingMessageId}`,
    undefined,
    true
  );
  return true;
}

// Run the agent and stream its response. When isApproval is false (initial
// request), store a pending approval so the user can ✅/❌ to trigger
// execution.
//
// historyThreadId: when provided (reaction context), use this for agent history
// instead of thread.id so history is scoped to the correct conversation.
async function runAgentAndRespond(
  thread: Thread<unknown, unknown>,
  userText: string,
  originalMessageId: string,
  slackUserId?: string,
  historyThreadId?: string,
  requestScopeId?: string,
  attachments?: FileAttachment[],
  isApproval = false
): Promise<void> {
  const agentThreadId = historyThreadId ?? thread.id;
  try {
    await thread.startTyping();
    const stream = await runAgent(agentThreadId, userText, {
      requestScopeId,
      attachments,
    });

    const sent = await thread.post(stream);

    if (!isApproval) {
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

  } catch (err) {
    if (err instanceof NotConnectedError) {
      await thread.post(notConnectedMessage());
      return;
    }
    console.error("[contentful-bot] agent error:", err);
    await thread.post(
      "Sorry, I ran into an error while processing your request. Please try again."
    );
  }
}

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await thread.adapter.addReaction(thread.id, message.id, emoji.eyes);
  const files = await downloadAttachments(message.attachments);
  await runAgentAndRespond(
    thread,
    message.text ?? "",
    message.id,
    message.author?.userId,
    undefined,
    `message:${message.id}`,
    files
  );
});

bot.onSubscribedMessage(async (thread, message) => {
  await thread.adapter.addReaction(thread.id, message.id, emoji.eyes);
  const handledApproval = await tryHandlePendingExecution(
    thread,
    message.text ?? "",
    message.author?.userId
  );
  if (handledApproval) return;
  const files = await downloadAttachments(message.attachments);
  await runAgentAndRespond(
    thread,
    message.text ?? "",
    message.id,
    message.author?.userId,
    undefined,
    `message:${message.id}`,
    files
  );
});

bot.onAppHomeOpened(async (event) => {
  await publishHomeTab(event.userId);
});

bot.onSlashCommand("/connect", async (event) => {
  const connectUrl = `${getConnectUrl()}?uid=${encodeURIComponent(event.user.userId)}`;
  await event.channel.postEphemeral(
    event.user,
    <Card title="Connect Contentful">
      <CardText>Click the button below to authorize this bot with your Contentful account.</CardText>
      <Actions>
        <LinkButton url={connectUrl} style="primary">Connect to Contentful</LinkButton>
      </Actions>
    </Card>,
    { fallbackToDM: false }
  );
});

bot.onSlashCommand("/disconnect", async (event) => {
  await handleDisconnect(event.user.userId);
  await event.channel.postEphemeral(
    event.user,
    "✅ Contentful has been disconnected from this workspace.",
    { fallbackToDM: false }
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
  await runAgentAndRespond(
    event.thread,
    "Yes, please proceed.",
    originalMessageId,
    pendingUserId,
    pending.threadId,
    `approval:${event.messageId}`,
    undefined,
    true
  );
});
