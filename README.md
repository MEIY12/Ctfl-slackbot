This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Slack Bot Approval Behavior

- Plan and execute flows are scoped per Slack thread so different threads can run at the same time.
- When a thread is waiting for approval, free-form replies are interpreted semantically as approve, cancel, or unclear.
- If a reply is unclear, the bot does not auto-execute and the conversation continues normally.
- Users can always use ✅ to proceed or ❌ to cancel on the bot's pending message.

## MCP connections

Run `/connect` in Slack to authorize Contentful and Palmata separately. Contentful provides CMS read/write tools; Palmata provides read-only AEO discovery and report tools. Either connection is sufficient to use the bot, and when both are connected, one conversation can use both sources and the response labels the findings by source.

Run `/disconnect` to remove both stored connections. Palmata's OAuth callback is `/api/auth/palmata/callback`, so the deployed `APP_URL` must be registered consistently with the other callback.
