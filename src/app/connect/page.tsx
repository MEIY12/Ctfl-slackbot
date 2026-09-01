import Link from "next/link";
import Redis from "ioredis";
import { getPalmataToken, getStoredToken } from "@/lib/auth";

export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<{ uid?: string }>;
}) {
  const { uid } = await searchParams;
  const startHref = uid
    ? `/api/auth/contentful/start?uid=${encodeURIComponent(uid)}`
    : "/api/auth/contentful/start";
  const palmataHref = uid
    ? `/api/auth/palmata/start?uid=${encodeURIComponent(uid)}`
    : "/api/auth/palmata/start";
  const redis = new Redis(process.env.REDIS_URL!);
  let contentfulConnected = false;
  let palmataConnected = false;
  try {
    [contentfulConnected, palmataConnected] = await Promise.all([
      getStoredToken(redis).then(Boolean),
      getPalmataToken(redis).then(Boolean),
    ]);
  } finally {
    await redis.quit();
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
          {contentfulConnected && palmataConnected && (
            <p className="mt-2 text-center text-sm text-green-600 dark:text-green-400">
              Both services are connected. You can close this page and return to Slack.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
