/** @jsxImportSource chat */
import { Chat } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";
import Redis from "ioredis";
import { runAgent, NotConnectedError } from "./agent";
import { getConnectUrl, clearToken } from "./auth";

export const bot = new Chat({
  userName: "contentful-bot",
  adapters: {
    slack: createSlackAdapter(),
  },
  state: createRedisState(),
});

function notConnectedMessage(): string {
  const connectUrl = getConnectUrl();
  return (
    `*Contentful isn't connected yet.* ` +
    `An admin needs to authorize this bot before it can manage content.\n\n` +
    `*<${connectUrl}|Connect to Contentful →>*`
  );
}

// Returns true if the message is a disconnect command (strips bot mention first)
function isDisconnectCommand(text: string): boolean {
  const cleaned = text.replace(/<@[^>]+>/g, "").trim().toLowerCase();
  return cleaned === "disconnect" || cleaned === "disconnect contentful";
}

// When a user @mentions the bot, subscribe to the thread and start an agent conversation
bot.onNewMention(async (thread, message) => {
  await thread.subscribe();

  const threadId = thread.id;
  const userText = message.text ?? "";

  // Handle disconnect command before sending to the agent
  if (isDisconnectCommand(userText)) {
    const redis = new Redis(process.env.REDIS_URL!);
    try {
      await clearToken(redis);
      await thread.post(
        "*Contentful disconnected.* The bot will prompt for authorization on the next @mention."
      );
    } finally {
      await redis.quit();
    }
    return;
  }

  try {
    const textStream = await runAgent(threadId, userText);
    // PostableMessage includes AsyncIterable<string>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await thread.post(textStream as any);
  } catch (err) {
    if (err instanceof NotConnectedError) {
      await thread.post(notConnectedMessage());
      return;
    }
    console.error("[contentful-bot] agent error on mention:", err);
    await thread.post(
      "Sorry, I ran into an error while processing your request. Please try again."
    );
  }
});

// When a user replies in a subscribed thread, continue the conversation
bot.onSubscribedMessage(async (thread, message) => {
  const threadId = thread.id;
  const userText = message.text ?? "";

  try {
    const textStream = await runAgent(threadId, userText);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await thread.post(textStream as any);
  } catch (err) {
    if (err instanceof NotConnectedError) {
      await thread.post(notConnectedMessage());
      return;
    }
    console.error("[contentful-bot] agent error on reply:", err);
    await thread.post(
      "Sorry, I ran into an error while processing your request. Please try again."
    );
  }
});
