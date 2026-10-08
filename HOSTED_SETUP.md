# Hosted Setup: Vercel + Slack

This guide deploys a new copy of the bot using the same production pattern as the existing installation. No local setup is required.

## What you need

- A GitHub repository containing this codebase
- Access to a Vercel team that can import the repository
- A Slack workspace where you can create and install an app
- An OpenAI API key
- A hosted Redis database
- A Contentful and/or Palmata account to authorize after deployment

## 1. Create the Vercel project

1. In Vercel, choose **Add New → Project** and import the GitHub repository.
2. Select the intended Vercel team.
3. Keep the detected **Next.js** preset and the repository root (`./`).
4. Use Node.js 20 or newer.
5. Add `OPENAI_API_KEY`.
6. Deploy the project.

If the repository is private and owned by a GitHub organization, the Vercel team needs a plan and GitHub integration that can access it.

## 2. Add hosted Redis

1. In the Vercel project, open **Storage** or the Vercel Marketplace.
2. Create or attach an Upstash Redis database.
3. Add its TCP connection string to the Vercel project as `REDIS_URL`.

The value must begin with `redis://` or `rediss://`, for example:

```text
rediss://default:PASSWORD@HOST:PORT
```

This project uses `ioredis`. An `https://` REST endpoint and the `UPSTASH_REDIS_REST_*` variables are not substitutes for `REDIS_URL`.

Use a dedicated Redis database for this deployment. It stores shared OAuth credentials, conversation history, deduplication records, locks, and pending approvals.

## 3. Set the stable production URL

1. In Vercel, assign the final production domain to the project.
2. Confirm the domain is publicly accessible without a Vercel login.
3. Add it as `APP_URL`, including `https://` and excluding the trailing slash:

```text
APP_URL=https://your-production-domain.example.com
```

4. Redeploy the project.
5. Open `APP_URL` and confirm the status page loads.

Do not use a preview or branch deployment URL. Slack webhooks and OAuth callbacks need a stable URL.

### Deployment Protection

Slack must be able to POST directly to the deployment. In Vercel's **Deployment Protection** settings, ensure the production domain is not protected by Vercel Authentication or another login page.

The webhook must not redirect. A protected or redirecting endpoint can strip Slack's signature headers and produce:

```text
Slack signature headers are required
```

## 4. Prepare the Slack manifest

Open `slack-app-manifest.yaml` and replace every occurrence of:

```text
https://your-production-domain.example.com
```

with the exact `APP_URL` value. Keep `/api/webhooks/slack` on each request URL.

The final webhook URL should look like:

```text
https://your-production-domain.example.com/api/webhooks/slack
```

## 5. Create and install the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps).
2. Choose **Create New App → From a manifest**.
3. Select the target workspace.
4. Paste or upload `slack-app-manifest.yaml`.
5. Review and create the app.
6. Open **OAuth & Permissions** and choose **Install to Workspace**.
7. Copy the **Bot User OAuth Token** beginning with `xoxb-`.
8. Open **Basic Information → App Credentials**.
9. Reveal and copy the **Signing Secret**.

An app-level token beginning with `xapp-` is not required. This deployment uses HTTPS webhooks, not Socket Mode.

## 6. Add the Slack credentials to Vercel

Add these production environment variables:

```text
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
```

The complete required set is:

```text
APP_URL=https://your-production-domain.example.com
OPENAI_API_KEY=...
REDIS_URL=rediss://...
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
```

Optional:

```text
AGENT_MAX_STEPS=30
AGENT_DEBUG=0
```

No Contentful or Palmata API tokens are needed in Vercel; those services are connected through OAuth.

Redeploy after saving the variables.

## 7. Verify Slack configuration

In the Slack app settings, confirm:

- **Event Subscriptions** is enabled and its Request URL is accepted.
- **Interactivity & Shortcuts** uses the same webhook URL.
- `/connect` and `/disconnect` use the same webhook URL.
- **App Home** has the Home tab enabled.

If scopes are changed after installation, reinstall the app so its bot token receives them.

## 8. Connect services and test

1. Invite the bot to each public or private Slack channel where it should operate.
2. Run `/connect`.
3. Authorize Contentful, Palmata, or both.
4. For Contentful, select the organizations and spaces the bot may access.
5. Open the bot's Home tab and confirm the connection status.
6. Mention the bot in an invited channel.
7. Confirm it adds an eyes reaction and replies in a thread.
8. Test one approved and one cancelled Contentful change before broader use.

The Contentful and Palmata connections are shared by everyone using this deployment. `/disconnect` clears both service connections for the entire deployment.

## Troubleshooting

- **`/connect` says the app did not respond:** verify every Slack request URL uses the public production domain directly, not a protected preview domain or redirect.
- **Slack signature headers are required:** remove Vercel Authentication from the webhook domain and confirm Slack is not calling an old URL.
- **Slack rejects the Request URL:** confirm the deployment is live, the path is `/api/webhooks/slack`, and `SLACK_SIGNING_SECRET` belongs to this Slack app.
- **The bot cannot post or react:** verify the token starts with `xoxb-`, then reinstall the app after any scope changes.
- **Thread replies are ignored:** invite the bot to the channel and confirm `message.channels` and `message.groups` are subscribed.
- **Attachments cannot be read:** confirm `files:read` is installed and reinstall after adding it.
- **Redis errors:** use the provider's TCP `redis://` or `rediss://` connection string.
- **OAuth fails after changing domains:** update `APP_URL`, update all Slack request URLs, redeploy, and remove the Redis keys `ctfl-bot:oauth:registered-client` and `ctfl-bot:oauth:palmata-registered-client` before reconnecting.
- **The model fails before using tools:** verify the OpenAI key, billing, and access to the model configured in `src/lib/agent.ts`.
