/** @jsxImportSource chat */
import { Chat, emoji, type Thread } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";
import { runAgent, NotConnectedError } from "./agent";
import { getConnectUrl } from "./auth";

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

// Run the agent, post its response, then store the bot's response message
// as the pending target so the user can ✅/❌ react to it.
//
// historyThreadId: when provided (reaction context), use this for agent history
// instead of thread.id, and collect the stream to text before posting because
// reaction event threads have no _currentMessage and cannot stream.
async function runAgentAndAwaitConfirmation(
  thread: Thread,
  userText: string,
  originalMessageId: string,
  slackUserId?: string,
  historyThreadId?: string
): Promise<void> {
  const agentThreadId = historyThreadId ?? thread.id;
  try {
    const textStream = await runAgent(agentThreadId, userText);

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

    await bot.getState().set(`pending:${sent.id}`, {
      threadId: agentThreadId,
      originalMessageId,
      pendingUserId: slackUserId,
    }, 1000 * 60 * 60 * 24);
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
  await runAgentAndAwaitConfirmation(thread, message.text ?? "", message.id, message.author?.userId);
});

// Handle ✅ (proceed) and ❌ (cancel) reactions on bot responses
bot.onReaction(["check", "x"], async (event) => {
  if (!event.added) return;
  if (event.user.isMe) return;

  // Look up pending data by message ID — avoids thread ID mismatch between
  // where state was stored and the thread ID the reaction event carries.
  const pending = await bot.getState().get<{
    threadId: string;
    originalMessageId: string;
    pendingUserId?: string;
  }>(`pending:${event.messageId}`);

  if (!pending) return;

  const { threadId, originalMessageId, pendingUserId } = pending;

  // Clear pending state regardless of outcome
  await bot.getState().delete(`pending:${event.messageId}`);

  if (event.emoji === emoji.x) {
    // User cancelled — remove the eyes from the original user message
    await event.adapter.removeReaction(threadId, originalMessageId, emoji.eyes);
    return;
  }

  // User confirmed — react with eyes on the bot's message to show we're on it
  await event.adapter.addReaction(event.threadId, event.messageId, emoji.eyes);

  // Continue the conversation — pass pending.threadId so agent uses correct
  // history and post is non-streaming (reaction threads have no _currentMessage)
  await runAgentAndAwaitConfirmation(
    event.thread,
    "Yes, please proceed.",
    originalMessageId,
    pendingUserId,
    pending.threadId
  );
});
