import { after } from "next/server";
import { bot } from "@/lib/bot";
import { publishHomeTab, handleDisconnect } from "@/lib/slack-home";
import { getConnectUrl } from "@/lib/auth";

type Platform = keyof typeof bot.webhooks;

type SlackIntercept =
  | { type: "app_home_opened"; userId: string }
  | { type: "slash_connect"; userId: string }
  | { type: "slash_disconnect"; userId: string };

function parseSlackIntercept(
  rawBody: string,
  contentType: string | null
): SlackIntercept | null {
  try {
    if (contentType?.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(rawBody);
      const payloadStr = params.get("payload");

      if (payloadStr) {
        // Interactivity payload (block actions) — no longer used but parsed defensively
        return null;
      }

      // Slash command
      const command = params.get("command");
      const userId = params.get("user_id");

      if (!userId) return null;

      if (command === "/connect") {
        return { type: "slash_connect", userId };
      }
      if (command === "/disconnect") {
        return { type: "slash_disconnect", userId };
      }
    } else {
      // Regular event callbacks are JSON
      const payload = JSON.parse(rawBody);
      if (
        payload.type === "event_callback" &&
        payload.event?.type === "app_home_opened"
      ) {
        return { type: "app_home_opened", userId: payload.event.user };
      }
    }
  } catch {
    // Not JSON or not a payload we care about
  }
  return null;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ platform: string }> }
) {
  const { platform } = await context.params;
  const handler = bot.webhooks[platform as Platform];
  if (!handler) {
    return new Response(`Unknown platform: ${platform}`, { status: 404 });
  }

  if (platform === "slack") {
    // Clone before reading so the original is still consumable by the Chat SDK
    const clone = request.clone();
    const rawBody = await clone.text();
    const contentType = request.headers.get("content-type");
    const intercept = parseSlackIntercept(rawBody, contentType);

    if (intercept?.type === "app_home_opened") {
      // Publish the home tab asynchronously — still pass the event to Chat SDK
      after(async () => {
        try {
          await publishHomeTab(intercept.userId);
        } catch (e) {
          console.error("[contentful-bot] home tab publish error:", e);
        }
      });
    } else if (intercept?.type === "slash_connect") {
      const connectUrl = `${getConnectUrl()}?uid=${encodeURIComponent(intercept.userId)}`;
      return Response.json({
        response_type: "ephemeral",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Connect Contentful to this workspace*\nClick the button below to authorize the bot with your Contentful account.",
            },
            accessory: {
              type: "button",
              text: { type: "plain_text", text: "Connect to Contentful", emoji: true },
              style: "primary",
              url: connectUrl,
              action_id: "contentful_connect_link",
            },
          },
        ],
      });
    } else if (intercept?.type === "slash_disconnect") {
      after(async () => {
        try {
          await handleDisconnect(intercept.userId);
        } catch (e) {
          console.error("[contentful-bot] slash disconnect error:", e);
        }
      });
      return Response.json({
        response_type: "ephemeral",
        text: "✅ Contentful has been disconnected from this workspace.",
      });
    }
  }

  return handler(request, {
    waitUntil: (task) => after(() => task),
  });
}
