import Redis from "ioredis";
import { getStoredToken, clearToken } from "./auth";

const SLACK_API = "https://slack.com/api";

export async function publishHomeTab(userId: string): Promise<void> {
  const redis = new Redis(process.env.REDIS_URL!);
  let isConnected = false;

  try {
    const token = await getStoredToken(redis);
    isConnected = !!token;
  } finally {
    await redis.quit();
  }

  const view = {
    type: "home",
    blocks: isConnected ? connectedBlocks() : disconnectedBlocks(),
  };

  const res = await fetch(`${SLACK_API}/views.publish`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ user_id: userId, view }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[contentful-bot] views.publish failed:", text);
  }
}

export async function handleDisconnect(userId: string): Promise<void> {
  const redis = new Redis(process.env.REDIS_URL!);
  try {
    await clearToken(redis);
    console.log("[contentful-bot] Contentful disconnected by user", userId);
  } finally {
    await redis.quit();
  }
  await publishHomeTab(userId);
}

function connectedBlocks() {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Contentful Bot", emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Status:* ✅ Connected to Contentful\n\nThe bot is authorized and ready to manage content in this workspace.",
      },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*How to use:*\n• Mention *@ContentfulBot* in any channel to start a task\n• Reply in the thread to continue the conversation\n• Ask it to create campaigns, banners, pages, blog posts, FAQs, and more",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Manage connection:*\nTo disconnect, run `/disconnect` in any channel.",
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Content is only published when you explicitly ask. Large changes are confirmed before execution.",
        },
      ],
    },
  ];
}

function disconnectedBlocks() {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Contentful Bot", emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Status:* ❌ Not connected\n\nAn admin needs to authorize this bot with Contentful before it can manage content.",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "To connect, run `/connect` in any channel.",
      },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*What you can do after connecting:*\n• Create full content campaigns with banners, pages, and components\n• Manage blog posts, FAQ entries, and more\n• Publish and update content — all from Slack",
      },
    },
  ];
}
