import { after } from "next/server";
import { bot } from "@/lib/bot";
import { publishHomeTab, handleDisconnect } from "@/lib/slack-home";

type Platform = keyof typeof bot.webhooks;

type SlackIntercept =
  | { type: "app_home_opened"; userId: string }
  | { type: "disconnect_action"; userId: string };

function parseSlackIntercept(
  rawBody: string,
  contentType: string | null
): SlackIntercept | null {
  try {
    if (contentType?.includes("application/x-www-form-urlencoded")) {
      // Slack interactivity payloads are URL-encoded: payload=<json>
      const params = new URLSearchParams(rawBody);
      const payloadStr = params.get("payload");
      if (!payloadStr) return null;

      const payload = JSON.parse(payloadStr);
      if (
        payload.type === "block_actions" &&
        Array.isArray(payload.actions) &&
        payload.actions.some(
          (a: { action_id: string }) => a.action_id === "contentful_disconnect"
        )
      ) {
        return { type: "disconnect_action", userId: payload.user?.id };
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
    } else if (intercept?.type === "disconnect_action") {
      // Handle entirely ourselves — no need to pass to Chat SDK
      after(async () => {
        try {
          await handleDisconnect(intercept.userId);
        } catch (e) {
          console.error("[contentful-bot] disconnect error:", e);
        }
      });
      return new Response("", { status: 200 });
    }
  }

  return handler(request, {
    waitUntil: (task) => after(() => task),
  });
}
