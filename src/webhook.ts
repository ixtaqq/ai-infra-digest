#!/usr/bin/env node
/**
 * Telegram Webhook Server
 *
 * An always-on HTTP entry point so interactive commands (/digest, /sec,
 * /watchlist, /alert, /feedback, …) actually respond in production. Unlike the
 * GitHub Actions runs — which start polling, run the pipeline, then exit within
 * ~2 minutes — this process stays up and receives Telegram updates via webhook.
 *
 * Deploy on any always-on host (Render / Railway / Fly.io / a VPS / Docker).
 * Telegram is serverless-friendly too: each update is one HTTP POST, so this can
 * also back a serverless function by reusing {@link decideWebhook}.
 *
 * Env:
 *   PORT            HTTP port to listen on (default 3000; hosts usually inject this)
 *   WEBHOOK_URL     Public base URL, e.g. https://my-bot.onrender.com — when set,
 *                   the webhook is auto-registered with Telegram on startup
 *   WEBHOOK_PATH    Path that receives updates (default /telegram/webhook)
 *   WEBHOOK_SECRET  Shared secret; Telegram echoes it in the
 *                   X-Telegram-Bot-Api-Secret-Token header. Rejects mismatches.
 *
 * Run: npm run webhook   (dev)  /  node dist/webhook.js   (prod)
 */
import http from "http";
import { logger } from "./utils/logger";
import {
  enableWebhookMode,
  handleWebhookUpdate,
  startInteractiveBot,
  setupWebhook,
} from "./sender/telegram";
import { registerDigestCommands } from "./index";

export interface WebhookDecision {
  /** HTTP status to respond with. */
  status: number;
  /** Short response body. */
  body: string;
  /** Parsed Telegram update to process — present only when the request is valid. */
  update?: unknown;
}

/**
 * Pure routing + auth decision for an incoming HTTP request. Kept dependency-free
 * so it can be unit-tested and reused by serverless adapters. Decides the response
 * status and, for a valid update POST, returns the parsed update to process.
 */
export function decideWebhook(opts: {
  method?: string;
  url?: string;
  webhookPath: string;
  secret?: string;
  secretHeader?: string | string[];
  rawBody: string;
}): WebhookDecision {
  const { method, url, webhookPath, secret, secretHeader, rawBody } = opts;

  // Health check
  if (method === "GET" && (url === "/" || url === "/health")) {
    return { status: 200, body: "ok" };
  }

  if (method !== "POST" || url !== webhookPath) {
    return { status: 404, body: "not found" };
  }

  // Secret-token check (Telegram sends it back in this header when configured).
  if (secret) {
    const provided = Array.isArray(secretHeader) ? secretHeader[0] : secretHeader;
    if (provided !== secret) {
      return { status: 403, body: "forbidden" };
    }
  }

  let update: unknown;
  try {
    update = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: "bad request" };
  }

  return { status: 200, body: "ok", update };
}

function createServer(): http.Server {
  const webhookPath = process.env.WEBHOOK_PATH || "/telegram/webhook";
  const secret = process.env.WEBHOOK_SECRET || undefined;

  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      chunks.push(c);
      // Guard against oversized bodies (Telegram updates are tiny).
      if (chunks.reduce((n, b) => n + b.length, 0) > 1_000_000) {
        tooLarge = true;
        req.destroy();
      }
    });
    req.on("end", () => {
      if (tooLarge) {
        res.writeHead(413);
        res.end("payload too large");
        return;
      }
      const decision = decideWebhook({
        method: req.method,
        url: req.url,
        webhookPath,
        secret,
        secretHeader: req.headers["x-telegram-bot-api-secret-token"],
        rawBody: Buffer.concat(chunks).toString("utf8"),
      });

      if (decision.update !== undefined) {
        try {
          handleWebhookUpdate(decision.update as Parameters<typeof handleWebhookUpdate>[0]);
        } catch (err) {
          logger.warn(`Failed to process Telegram update: ${(err as Error).message}`);
        }
      }

      res.writeHead(decision.status);
      res.end(decision.body);
    });
  });
}

async function main(): Promise<void> {
  // The webhook port is reachable by anyone with network access to the host
  // (VPN, same cloud region, exploited box) even before WEBHOOK_URL is registered
  // with Telegram — an unauthenticated listener is never safe, so the secret is
  // required unconditionally rather than only once WEBHOOK_URL is set.
  if (!process.env.WEBHOOK_SECRET) {
    throw new Error(
      "WEBHOOK_SECRET is required to start the webhook server. " +
        "Set it in your environment and configure it in @BotFather (Telegram → Bot → Edit Bot → Webhook Secret)."
    );
  }

  // Configure the bot for webhook (non-polling) mode BEFORE any handler registers.
  enableWebhookMode();
  registerDigestCommands();
  startInteractiveBot();

  const port = parseInt(process.env.PORT || "3000", 10);
  const webhookPath = process.env.WEBHOOK_PATH || "/telegram/webhook";
  const publicUrl = process.env.WEBHOOK_URL;
  const secret = process.env.WEBHOOK_SECRET || undefined;

  const server = createServer();
  server.listen(port, async () => {
    logger.info(`Telegram webhook server listening on :${port}${webhookPath}`);

    if (publicUrl) {
      const fullUrl = `${publicUrl.replace(/\/$/, "")}${webhookPath}`;
      const ok = await setupWebhook(fullUrl, {
        secretToken: secret,
        allowedUpdates: ["message", "callback_query"],
      });
      logger.info(ok ? `Webhook registered with Telegram: ${fullUrl}` : "Webhook registration FAILED — check the token/URL");
    } else {
      logger.warn(
        "WEBHOOK_URL not set — server is up but Telegram doesn't know where to send updates. " +
          "Set WEBHOOK_URL (and redeploy) or register the webhook manually."
      );
    }
  });
}

if (require.main === module) {
  main().catch((err) => {
    logger.error(`Webhook server failed to start: ${(err as Error).message}`);
    process.exit(1);
  });
}
