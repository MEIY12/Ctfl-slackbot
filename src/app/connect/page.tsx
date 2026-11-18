import Link from "next/link";
import Redis from "ioredis";
import { getAppUrl, getPalmataToken, getStoredToken } from "@/lib/auth";

export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<{ uid?: string; disconnected?: string; contentful_error?: string }>;
}) {
  const { uid, disconnected, contentful_error } = await searchParams;
  const appUrl = getAppUrl();
  const contentfulStartParams = new URLSearchParams();
  if (uid) contentfulStartParams.set("uid", uid);
  const startHref = `${appUrl}/api/auth/contentful/start${
    contentfulStartParams.toString() ? `?${contentfulStartParams}` : ""
  }`;
  const contentfulRetryHref = `${appUrl}/api/auth/contentful/start?reset=1${
    uid ? `&uid=${encodeURIComponent(uid)}` : ""
  }`;
  const palmataHref = `${appUrl}/api/auth/palmata/start${uidQuery}`;
  const disconnectAction = `${appUrl}/api/auth/disconnect`;

  let contentfulConnected = false;
  let palmataConnected = false;
  let configError: string | null = null;

  if (!process.env.REDIS_URL) {
    configError = "REDIS_URL is not set on this deployment.";
  } else {
    const redis = new Redis(process.env.REDIS_URL);
    try {
      [contentfulConnected, palmataConnected] = await Promise.all([
        getStoredToken(redis).then(Boolean),
        getPalmataToken(redis).then(Boolean),
      ]);
    } catch {
      configError = "Could not reach Redis. Check REDIS_URL on Vercel.";
    } finally {
      await redis.quit();
    }
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">
      <div className="w-full max-w-md px-6 py-16">
        <div className="rounded-2xl border border-zinc-200 bg-white p-10 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          {/* Logo row */}
          <div className="mb-8 flex items-center justify-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600 text-white text-xl font-bold shadow-sm">
              C
            </div>
            <div className="text-zinc-300 dark:text-zinc-600 text-2xl font-light">+</div>
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#4A154B] text-white shadow-sm">
              <svg viewBox="0 0 54 54" className="h-6 w-6 fill-current">
                <path d="M19.712.133a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386h5.376V5.52A5.381 5.381 0 0 0 19.712.133m0 14.365H5.376A5.381 5.381 0 0 0 0 19.884a5.381 5.381 0 0 0 5.376 5.387h14.336a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386" />
                <path d="M53.76 19.884a5.381 5.381 0 0 0-5.376-5.386 5.381 5.381 0 0 0-5.376 5.386v5.387h5.376a5.381 5.381 0 0 0 5.376-5.387m-14.336 0V5.52A5.381 5.381 0 0 0 34.048.133a5.381 5.381 0 0 0-5.376 5.387v14.364a5.381 5.381 0 0 0 5.376 5.387 5.381 5.381 0 0 0 5.376-5.387" />
                <path d="M34.048 54a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386h-5.376v5.386A5.381 5.381 0 0 0 34.048 54m0-14.365h14.336a5.381 5.381 0 0 0 5.376-5.386 5.381 5.381 0 0 0-5.376-5.387H34.048a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386" />
                <path d="M0 34.249a5.381 5.381 0 0 0 5.376 5.386 5.381 5.381 0 0 0 5.376-5.386v-5.387H5.376A5.381 5.381 0 0 0 0 34.249m14.336 0v14.364A5.381 5.381 0 0 0 19.712 54a5.381 5.381 0 0 0 5.376-5.387V34.249a5.381 5.381 0 0 0-5.376-5.387 5.381 5.381 0 0 0-5.376 5.387" />
              </svg>
            </div>
          </div>

          <div className="mb-6 text-center">
            <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              Connect Contentful and Palmata to Slack
            </h1>
            <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed">
              Authorize either service, or both, so the bot can manage Contentful content and answer AEO discovery questions directly from Slack.
            </p>
          </div>

          {contentful_error && (
            <p className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-300">
              Contentful authorization error: {contentful_error}
            </p>
          )}

          {configError && (
            <p className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-300">
              {configError} Use the production URL:{" "}
              <a href={appUrl} className="underline font-medium">
                {appUrl}
              </a>
            </p>
          )}

          <div className="mb-6 rounded-lg bg-zinc-50 dark:bg-zinc-800 px-4 py-3 text-sm text-zinc-600 dark:text-zinc-300 space-y-1.5">
            <div className="flex items-start gap-2">
              <span className="text-green-500 mt-0.5">✓</span>
              <span>Contentful: {contentfulConnected ? "Connected" : "Not connected"}</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-green-500 mt-0.5">✓</span>
              <span>Palmata: {palmataConnected ? "Connected" : "Not connected"}</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-green-500 mt-0.5">✓</span>
              <span>Access the spaces you select during authorization</span>
            </div>
          </div>

          {!contentfulConnected && (
            <>
              <Link
                href={startHref}
                className="block w-full rounded-lg bg-blue-600 px-4 py-3 text-center text-sm font-semibold text-white shadow-sm hover:bg-blue-700 transition-colors"
              >
                Authorize with Contentful
              </Link>
              <Link
                href={contentfulRetryHref}
                className="mt-2 block w-full text-center text-xs font-medium text-blue-700 underline dark:text-blue-300"
              >
                Contentful failed before? Reset OAuth and try again
              </Link>
              <p className="mt-4 text-center text-xs text-zinc-400 dark:text-zinc-500">
                You will be redirected to Contentful to approve access. No passwords are stored.
              </p>
            </>
          )}
          {!palmataConnected && (
            <>
              <Link
                href={palmataHref}
                className="mt-3 block w-full rounded-lg bg-violet-600 px-4 py-3 text-center text-sm font-semibold text-white shadow-sm hover:bg-violet-700 transition-colors"
              >
                Authorize with Palmata
              </Link>
              <p className="mt-4 text-center text-xs text-zinc-400 dark:text-zinc-500">
                Palmata access is read-only and limited to the reports and organization data you authorize.
              </p>
            </>
          )}
          {(contentfulConnected || palmataConnected) && (
            <div className="mt-4 space-y-3">
              {contentfulConnected && palmataConnected && (
                <p className="text-center text-sm text-green-600 dark:text-green-400">
                  Both services are connected. You can close this page and return to Slack.
                </p>
              )}
              {disconnected === "1" && (
                <p className="text-center text-sm text-green-600 dark:text-green-400">
                  Connections cleared. Authorize again below or run `/connect` in Slack.
                </p>
              )}
              <form action={disconnectAction} method="post">
                <button
                  type="submit"
                  className="block w-full rounded-lg border border-zinc-300 bg-white px-4 py-3 text-center text-sm font-semibold text-zinc-800 shadow-sm hover:bg-zinc-50 transition-colors dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
                >
                  Disconnect Contentful and Palmata
                </button>
              </form>
              <p className="text-center text-xs text-zinc-400 dark:text-zinc-500">
                Use this if `/disconnect` in Slack fails, or you need a clean reconnect after an auth error.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
