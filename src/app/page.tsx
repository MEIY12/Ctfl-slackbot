export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">
      <main className="w-full max-w-lg px-8 py-16">
        <div className="rounded-2xl border border-zinc-200 bg-white p-10 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-8 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 text-white text-lg font-bold">
              C
            </div>
            <div>
              <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                Contentful Slack Bot
              </h1>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                AI-powered content management via Slack
              </p>
            </div>
          </div>

          <div className="mb-6 rounded-lg bg-green-50 px-4 py-3 dark:bg-green-950/30">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-green-500" />
              <span className="text-sm font-medium text-green-800 dark:text-green-400">
                Webhook active at{" "}
                <code className="font-mono">/api/webhooks/slack</code>
              </span>
            </div>
          </div>

          <ul className="space-y-2 text-sm text-zinc-600 dark:text-zinc-400">
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-zinc-400">→</span>
              <span>
                Mention <code className="font-mono text-zinc-800 dark:text-zinc-200">@contentful-bot</code> in any Slack channel to start a content task
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-zinc-400">→</span>
              <span>
                Reply in the same thread to continue the conversation
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-zinc-400">→</span>
              <span>
                Ask the bot to create campaigns, banners, pages, blog posts, FAQs, and more
              </span>
            </li>
          </ul>
        </div>
      </main>
    </div>
  );
}
