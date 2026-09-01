# Contentful + Palmata Ops Slack Bot

A Slack bot for Contentful content operations and Palmata AEO research. It uses:

- [Next.js](https://nextjs.org/) for the web app and webhook routes
- [Chat SDK](https://chat-sdk.dev/) for Slack events, messages, and thread state
- [Vercel AI SDK](https://ai-sdk.dev/) with OpenAI for the agent
- Contentful MCP for CMS reads and approved mutations
- Palmata MCP for read-only report and discovery data
- Redis for OAuth tokens, conversation history, deduplication, locks, and approvals

The bot responds to mentions, continues conversations in Slack threads, accepts supported file attachments, and requires approval before executing Contentful mutations.

## Prerequisites

- Node.js 20.9 or newer
- npm
- A Slack workspace where you can create and install an app
- An OpenAI API key with access to the model configured in `src/lib/agent.ts`
- A Redis database
- A Contentful account and/or Palmata account to authorize through `/connect`
- A public HTTPS deployment for Slack webhooks and OAuth callbacks; Vercel is the supported path below

## Environment variables

Create `.env.local` for local development. It is ignored by Git.

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
REDIS_URL=redis://localhost:6379
OPENAI_API_KEY=sk-...
APP_URL=http://localhost:3000

# Optional
AGENT_MAX_STEPS=30
AGENT_DEBUG=0
```

Required variables:

- `SLACK_BOT_TOKEN`: the Slack app's Bot User OAuth Token.
- `SLACK_SIGNING_SECRET`: the signing secret under Slack **Basic Information → App Credentials**.
- `REDIS_URL`: a writable Redis TCP connection string. Use `redis://` locally or the provider's TLS `rediss://` URL in production.
- `OPENAI_API_KEY`: used server-side by `@ai-sdk/openai`.
- `APP_URL`: the stable public origin of this app, with no trailing slash, for example `https://your-project.vercel.app`.

Optional variables:

- `AGENT_MAX_STEPS`: maximum AI tool-loop steps. It defaults to `30` and values below `5` are ignored.
- `AGENT_DEBUG`: set to `1` to log detailed agent lifecycle traces.
- `VERCEL_URL`: Vercel provides this automatically as a fallback, but production should set `APP_URL` explicitly so OAuth always uses the stable production domain.

Static Contentful or Palmata API tokens are not environment variables in this project. Both services use OAuth with dynamic client registration, and their tokens are stored in Redis after `/connect`.

## Local setup

1. Clone the repository and install dependencies:

   ```bash
   git clone <repository-url>
   cd ctfl-palmata-ops-slack-bot
   npm ci
   ```

2. Start Redis. With Docker:

   ```bash
   docker run --name ctfl-palmata-redis -p 6379:6379 -d redis:7-alpine
   ```

   You can instead use any hosted Redis provider and put its TCP connection string in `REDIS_URL`.

3. Create `.env.local` using the variables above.

4. Start Next.js:

   ```bash
   npm run dev
   ```

5. Open [http://localhost:3000](http://localhost:3000). The page confirms the Slack webhook path at `/api/webhooks/slack`.

Slack cannot call `localhost`. For complete local webhook and OAuth testing, expose port 3000 through an HTTPS tunnel such as [ngrok](https://ngrok.com/) or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), set `APP_URL` to that origin, restart Next.js, and use the tunnel URL in Slack.

## Redis setup

Redis is required; the bot has no in-memory fallback. Use a dedicated database for each environment because it contains shared OAuth credentials and conversation state.

The easiest production option is through the Vercel UI:

1. Open the Vercel project and go to **Storage** or browse the [Vercel Marketplace](https://vercel.com/marketplace?category=storage).
2. Select a Redis provider such as **Upstash for Redis**.
3. Create or select a database and connect it to the project.
4. In **Project Settings → Environment Variables**, confirm that `REDIS_URL` contains the database's TCP connection string. Add it manually from the provider's **Connect** screen if the integration only supplied REST variables.
5. Redeploy so the new environment variable is available to the app.

You can also provision Redis directly with [Upstash](https://upstash.com/) or another hosted provider. This project uses `ioredis`, so `REDIS_URL` must be a TCP URL:

```bash
rediss://default:PASSWORD@HOST:PORT
```

Do not use an `https://` REST endpoint or only `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`; those credentials are for the separate `@upstash/redis` HTTP client. In Upstash, copy the ioredis/TCP connection string from **Connect**.

Choose a Redis region close to the Vercel Function region when possible. The database must allow outbound connections from Vercel and support TLS for a `rediss://` URL.

## Slack app setup

This project is a single-workspace Slack app. Create it at [api.slack.com/apps](https://api.slack.com/apps), then complete the following sections.

### 1. Create the app and permissions

Create an app **From scratch**, add a bot user, and enable the App Home **Home Tab**. The Messages Tab is not required.

Under **OAuth & Permissions → Bot Token Scopes**, add:

- `app_mentions:read`
- `channels:history`
- `channels:read`
- `chat:write`
- `commands`
- `files:read`
- `groups:history`
- `groups:read`
- `reactions:read`
- `reactions:write`
- `users:read`

Install the app to the workspace. Copy the `xoxb-...` Bot User OAuth Token and the app's signing secret into `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`.

If scopes change later, reinstall the Slack app so the installed token receives them.

### 2. Configure the public endpoint

Deploy the app first, then use the same URL for every Slack request:

```text
https://YOUR_APP_URL/api/webhooks/slack
```

Under **Event Subscriptions**, enable events, set that Request URL, and subscribe to these bot events:

- `app_mention`
- `message.channels`
- `message.groups`
- `app_home_opened`
- `reaction_added`
- `reaction_removed`

Under **Interactivity & Shortcuts**, enable interactivity and set the same Request URL.

Create these slash commands, each using the same Request URL:

- `/connect` — authorize Contentful and Palmata
- `/disconnect` — remove both stored service connections

Invite the bot to every public or private channel where it should operate. Slack only sends channel events that the installed app is allowed to see.

## Deploying to Vercel

1. Import the GitHub repository into [Vercel](https://vercel.com/new).
2. Keep the detected Next.js framework settings and use Node.js 20 or newer.
3. Connect a production Redis database and add its TCP URL as `REDIS_URL`.
4. Add `OPENAI_API_KEY`, `SLACK_BOT_TOKEN`, and `SLACK_SIGNING_SECRET` as sensitive environment variables.
5. Add `APP_URL` as the final production origin, such as `https://your-project.vercel.app`.
6. Deploy or redeploy after all environment variables are saved.
7. Configure Slack's events, interactivity, and slash commands with `APP_URL/api/webhooks/slack`.

The webhook route exports a 300-second maximum duration for agent runs. Vercel Fluid Compute supports 300 seconds on Hobby; longer limits require an eligible paid plan and a code change.

Vercel Hobby cannot connect a project to a private repository owned by a GitHub organization. Keep the deployment connected to a personal repository, make the organization repository public, or use a Vercel Pro team.

Use the stable production deployment for Slack—not preview URLs—because Slack request URLs and OAuth redirect URIs must remain consistent. Environment-variable changes only apply after a redeployment.

## Connecting Contentful and Palmata

After deployment and Slack setup:

1. Run `/connect` in Slack.
2. Authorize Contentful, Palmata, or both from the connection page.
3. For Contentful, select the organizations and spaces the bot may access.
4. Return to Slack and mention the bot in an invited channel.

Contentful supplies CMS read/write MCP tools. Palmata supplies read-only research, report, topic, competitor, and source data. The bot can operate with either connection and can combine both when available.

The connection is shared by everyone using this bot deployment:

- Redis stores one Contentful authorization and one Palmata authorization for the entire deployment.
- A later authorization replaces the previous token for that service.
- `/disconnect` clears both service tokens for everyone.
- The current code does not restrict `/connect` or `/disconnect` to Slack admins. Treat both as administrative commands and limit who can invoke them operationally.

No Contentful Management API token, space ID, or environment ID is required in Vercel. Access is determined by the Contentful user who completes OAuth.

## Approval and conversation behavior

- A mention starts a subscribed Slack thread; replies continue the same agent history.
- Histories are retained in Redis for seven days, up to 40 model messages.
- Read-only research and planning can run immediately.
- Contentful creates, updates, publishes, archives, and deletes require an approved plan.
- The requesting user can approve with a clear reply such as `approved` or `please proceed`, or react to the pending bot message with ✅.
- A cancellation reply or ❌ reaction cancels the pending action.
- Pending approvals expire after 24 hours.
- Images, PDFs, DOCX, and common text files are supported, up to 10 attachments and 20 MB per file.

## Verification

Run local checks:

```bash
npm run lint
npm run build
```

Verify the production integration:

1. Open `APP_URL` and confirm the status page loads.
2. Confirm Slack accepts `APP_URL/api/webhooks/slack` as the Request URL.
3. Open the app's Home tab and confirm connection status appears.
4. Run `/connect` and authorize at least one service.
5. Mention the bot in an invited channel and confirm it adds 👀 and replies in a thread.
6. Test an approved and a cancelled Contentful change before broader rollout.

## Troubleshooting

- **Slack rejects the Request URL:** confirm the deployment is live, the path is `/api/webhooks/slack`, and `SLACK_SIGNING_SECRET` exactly matches the Slack app.
- **The bot cannot post or react:** confirm the installed token starts with `xoxb-`, required scopes are present, and the app was reinstalled after scope changes.
- **Thread replies are ignored:** subscribe to `message.channels` and `message.groups`, then invite the bot to the channel.
- **Attachments cannot be read:** add `files:read`, reinstall the app, and verify the file is within the size and type limits.
- **Redis connection errors:** use a writable `redis://` or `rediss://` TCP connection string, not an Upstash REST URL.
- **OAuth fails after changing domains:** set the new stable `APP_URL`, redeploy, and delete the Redis keys `ctfl-bot:oauth:registered-client` and `ctfl-bot:oauth:palmata-registered-client` so the bot dynamically registers new clients with the new callback URLs.
- **OAuth state expired:** restart `/connect`; OAuth state lasts 10 minutes.
- **The model fails before using tools:** verify `OPENAI_API_KEY`, billing, and access to the model named in `src/lib/agent.ts`.
- **A private organization repo will not deploy on Hobby:** connect Vercel to a personal repository or move the project to a Pro team.

