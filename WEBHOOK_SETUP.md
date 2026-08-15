# Telegram Webhook Setup

Switching from long polling to a webhook makes the bot more reliable in production.
Polling works by repeatedly calling `getUpdates`, which wastes resources and can hit
Telegram's rate limits. A webhook pushes updates to your server immediately.

## Why this matters

The daily-digest and scheduled-delivery GitHub Actions runs start the polling bot,
do their work, then `process.exit(0)` within ~2 minutes. GitHub Actions has no
long-running process, so interactive commands (`/digest`, `/sec`, `/watchlist`,
`/alert`, `/feedback`, …) only respond during that brief window. To make them work
**24/7**, run the webhook server on an always-on host.

## Built-in webhook server

There is now a ready-to-run server: [`src/webhook.ts`](src/webhook.ts) (zero extra
deps — uses Node's `http`). It:

- registers all command handlers and puts the bot in **non-polling** mode
  (`enableWebhookMode()`),
- receives Telegram updates at `POST {WEBHOOK_PATH}` and dispatches them via
  `processUpdate`,
- verifies the `X-Telegram-Bot-Api-Secret-Token` header against `WEBHOOK_SECRET`
  (returns `403` on mismatch),
- auto-registers the webhook with Telegram on startup when `WEBHOOK_URL` is set.

### Environment

| Var | Required | Default | Purpose |
|---|---|---|---|
| `WEBHOOK_URL` | for auto-register | — | Public base URL, e.g. `https://my-bot.onrender.com` |
| `WEBHOOK_PATH` | ❌ | `/telegram/webhook` | Path that receives updates |
| `WEBHOOK_SECRET` | ✅ | — | Required to start the webhook server; rejects requests without it |
| `PORT` | ❌ | `3000` | Most hosts inject this automatically |

Plus the usual `TELEGRAM_BOT_TOKEN` (and `AI_API_KEY` / `SUPABASE_*` if commands
hit them).

If you enable Gmail delivery, `SMTP_PASS` must be a Google App Password—not the
normal Gmail account password. App Passwords require 2-Step Verification and are
16 characters without spaces; see the SMTP settings table in `README.md`.

### Run it

```bash
npm run webhook            # local dev (tsx)
npm run build && npm run start:webhook   # production (compiled)
```

Locally, expose it with a tunnel (`ngrok http 3000`) and set `WEBHOOK_URL` to the
tunnel URL so Telegram can reach you.

## Deploy (Render / Railway / Fly.io / any container host)

A [`Dockerfile`](Dockerfile) is included — it builds and runs `dist/webhook.js`.

1. Point your host at this directory (Docker build context = `ai-infra-digest/`).
2. Set env vars: `TELEGRAM_BOT_TOKEN`, `WEBHOOK_SECRET` (any random string),
   `WEBHOOK_URL` (your service's public URL), and `AI_API_KEY` / `SUPABASE_*` as
   needed. The host sets `PORT`.
3. Deploy. On boot the server registers the webhook automatically (look for
   `Webhook registered with Telegram` in the logs).

Render example: New → Web Service → "Deploy from a Dockerfile", set root directory
to `ai-infra-digest`, add the env vars above (`WEBHOOK_URL` =
`https://<service>.onrender.com`).

### Manual webhook registration (if you skip `WEBHOOK_URL`)

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://your-host/telegram/webhook" \
  -d "secret_token=<WEBHOOK_SECRET>"

curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

## Serverless (Vercel / Cloudflare) option

Each Telegram update is a single POST, so a serverless function works too — reuse
the pure router `decideWebhook(...)` from `src/webhook.ts` to validate the secret
and parse the body, then call `handleWebhookUpdate(update)`. (Note: Vercel and
GitHub Actions can't host the *polling* bot; only a webhook fits serverless.)

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

## Secret Token (Required)

The webhook server refuses to start without a secret token. Use the same value
when registering the webhook with Telegram:

```ts
await setupWebhook("https://example.com/webhook", {
  secretToken: process.env.WEBHOOK_SECRET,
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
