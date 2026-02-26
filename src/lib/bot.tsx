/** @jsxImportSource chat */
import { Chat, emoji, type Thread } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";
import { runAgent, NotConnectedError } from "./agent";
import { getConnectUrl } from "./auth";

const PENDING_TTL_MS = 1000 * 60 * 60 * 24;

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

async function clearPendingApproval(
  pendingMessageId: string,
  pending: PendingApproval
): Promise<void> {
  const state = bot.getState();
  await state.delete(pendingMessageKey(pendingMessageId));
  await state.delete(pendingThreadKey(pending.threadId));
  if (pending.pendingUserId) {
    await state.delete(pendingThreadKey(pending.threadId, pending.pendingUserId));
  }
}

async function tryHandlePendingExecution(
  thread: Thread<unknown, unknown>,
  messageText: string | undefined,
  userId: string | undefined
): Promise<boolean> {
  if (!userId) return false;

  const state = bot.getState();
  const pendingMessageId =
    (await state.get<string>(pendingThreadKey(thread.id, userId))) ??
    (await state.get<string>(pendingThreadKey(thread.id)));
  if (!pendingMessageId) return false;

  const pending = await state.get<PendingApproval>(pendingMessageKey(pendingMessageId));
  if (!pending) {
    await state.delete(pendingThreadKey(thread.id));
    return false;
  }

  if (pending.pendingUserId && pending.pendingUserId !== userId) {
    const targetUser = thread.mentionUser(pending.pendingUserId);
    await thread.post(`Only ${targetUser} can approve or cancel this action.`);
    return true;
  }

  const normalized = (messageText ?? "").trim().toLowerCase();
  if (["cancel", "stop", "never mind", "nevermind"].includes(normalized)) {
    await clearPendingApproval(pendingMessageId, pending);
    await thread.post("Understood — cancelled. Share updates anytime when you're ready.");
    return true;
  }

  await clearPendingApproval(pendingMessageId, pending);

  await runAgentAndAwaitConfirmation(
    thread,
    (messageText ?? "").trim() || "Yes, please proceed.",
    pending.originalMessageId,
    pending.pendingUserId,
    pending.threadId,
    "execute"
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
  executionMode: "plan" | "execute" = "plan"
): Promise<void> {
  const agentThreadId = historyThreadId ?? thread.id;
  try {
    const textStream = await runAgent(agentThreadId, userText, {
      slackUserId,
      executionMode,
    });

    let sent;
    if (historyThreadId) {
      // Reaction context: no _currentMessage on thread, streaming crashes.
      // Collect full text first, then post as a plain string.
      const chunks: string[] = [];
      for await (const chunk of textStream) {
        chunks.push(chunk);
      }
      const fullText = chunks.join("");
      sent = await thread.post(fullText);
    } else {
      // Message context: _currentMessage is set, streaming works fine.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sent = await thread.post(textStream as any);
    }

    if (executionMode === "plan") {
      const pending: PendingApproval = {
        threadId: agentThreadId,
        originalMessageId,
        pendingUserId: slackUserId,
      };
      await bot.getState().set(pendingMessageKey(sent.id), pending, PENDING_TTL_MS);
      await bot.getState().set(pendingThreadKey(agentThreadId), sent.id, PENDING_TTL_MS);
      if (slackUserId) {
        await bot.getState().set(
          pendingThreadKey(agentThreadId, slackUserId),
          sent.id,
          PENDING_TTL_MS
        );
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
  await runAgentAndAwaitConfirmation(thread, message.text ?? "", message.id, message.author?.userId);
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
  await runAgentAndAwaitConfirmation(thread, message.text ?? "", message.id, message.author?.userId);
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

  // Continue the conversation — pass pending.threadId so agent uses correct
  // history and post is non-streaming (reaction threads have no _currentMessage)
  await runAgentAndAwaitConfirmation(
    event.thread,
    "Yes, please proceed.",
    originalMessageId,
    pendingUserId,
    pending.threadId,
    "execute"
  );
});
