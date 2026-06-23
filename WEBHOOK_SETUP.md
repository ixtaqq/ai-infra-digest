# Telegram Webhook Setup

Switching from long polling to a webhook makes the bot more reliable in production.
Polling works by repeatedly calling `getUpdates`, which wastes resources and can hit
Telegram's rate limits. A webhook pushes updates to your server immediately.

## How It Works

The bot already has full webhook support built in:

- `setupWebhook(url, opts?)` — stops polling, deletes old webhook, sets new one
- `startWebhookBot(url, opts?)` — registers commands + sets webhook in one call
- `switchToPolling()` — deletes webhook, resumes polling (for local dev)
- `getWebhookInfo()` — returns webhook URL, pending update count, last error

## Option 1: Vercel (Recommended)

Vercel's serverless functions can receive Telegram updates easily.

### 1. Create `api/webhook.ts`

```ts
import type { VercelRequest, VercelResponse } from "@vercel/node";
import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN!;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const bot = new TelegramBot(TOKEN, { polling: false });
  try {
    await bot.processUpdate(req.body);
    res.status(200).send("OK");
  } catch (err) {
    res.status(500).send((err as Error).message);
  }
}
```

### 2. Deploy + Set Webhook

```bash
# Deploy to Vercel
npx vercel --prod

# Set the webhook (run once after deploy)
curl -X POST "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://your-domain.vercel.app/api/webhook"

# Verify
curl "https://api.telegram.org/bot<YOUR_TOKEN>/getWebhookInfo"
```

## Option 2: Cloudflare Workers

### 1. Create `worker.js`

```js
const TOKEN = TELEGRAM_BOT_TOKEN;
const BOT_HOST = "https://api.telegram.org";

async function handleUpdate(update) {
  // Forward update to your bot's processing endpoint
  // or process inline with grammY/telegraf
  const chatId = update.message?.chat?.id;
  if (!chatId) return new Response("OK");

  // Send response back
  await fetch(`${BOT_HOST}/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: "🤖 I'm alive!",
    }),
  });

  return new Response("OK");
}

export default {
  async fetch(request) {
    if (request.method === "POST") {
      return handleUpdate(await request.json());
    }
    return new Response("OK");
  },
};
```

### 2. Deploy + Set Webhook

```bash
npx wrangler deploy worker.js
# Then set webhook via Telegram API as above
```

## Option 3: Railway / Render / Fly.io (Express)

For a long-running Node server:

```ts
import express from "express";
import TelegramBot from "node-telegram-bot-api";

const app = express();
app.use(express.json());

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, { polling: false });

app.post("/webhook", async (req, res) => {
  try {
    await bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

// Set webhook on startup
const domain = process.env.RAILWAY_PUBLIC_DOMAIN!;
await bot.setWebHook(`https://${domain}/webhook`);

app.listen(process.env.PORT || 3000);
```

## Verifying Webhook Health

Use the built-in diagnostic:

```ts
import { getWebhookInfo } from "./src/sender/telegram";

const info = await getWebhookInfo();
console.log(`URL: ${info.url}`);
console.log(`Pending updates: ${info.pendingUpdates}`);
console.log(`Last error: ${info.lastError || "None"}`);
```

## Switching Back to Polling (Local Dev)

```ts
import { switchToPolling } from "./src/sender/telegram";
await switchToPolling();
```

## Secret Token (Optional but Recommended)

Set a secret token to verify that requests come from Telegram:

```ts
await setupWebhook("https://example.com/webhook", {
  secretToken: process.env.TELEGRAM_WEBHOOK_SECRET,
});
```

Then check the `X-Telegram-Bot-Api-Secret-Token` header in your endpoint.

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `403 Forbidden` when setting webhook | Invalid bot token | Check `TELEGRAM_BOT_TOKEN` |
| Webhook set but no updates | HTTPS required | Ensure your URL starts with `https://` |
| Certificate error | Invalid SSL | Use Vercel/Railway auto-cert |
| `409 Conflict` | Another webhook URL | Delete old: `deleteWebHook()` |
| `429 Too Many Requests` | Rate limited | Wait, use `maxConnections: 1` |
| Updates processed but no response | Route mismatch | Check `POST /webhook` handler |
