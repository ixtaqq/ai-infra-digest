import TelegramBot from "node-telegram-bot-api";
import { config } from "../config";
import { logger } from "../utils/logger";

let bot: TelegramBot | null = null;
let commandHandlersRegistered = false;

function getBot(): TelegramBot {
  if (!bot) {
    // Always create with polling: true so interactive commands work.
    // A polling bot can also send outgoing messages via sendMessage().
    bot = new TelegramBot(config.telegram.botToken, { polling: true });
  }
  return bot;
}

export interface SendResult {
  success: boolean;
  messageId?: number;
  error?: string;
}

// ─── Interactive Command Handlers ──────────────────────

export interface CommandContext {
  chatId: number;
  username?: string;
  firstName?: string;
  text: string;
}

export type CommandHandler = (
  ctx: CommandContext
) => Promise<string | { text: string; parseMode?: "HTML" | "MarkdownV2" }>;

const handlers = new Map<string, CommandHandler>();

/** Register a command handler (e.g., "digest", "sources"). */
export function registerCommand(
  command: string,
  handler: CommandHandler
): void {
  handlers.set(command, handler);
}

function initCommands() {
  if (commandHandlersRegistered) return;
  commandHandlersRegistered = true;

  const pollingBot = getBot();

  // Handle /start
  pollingBot.onText(/^\/start(@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    const text =
      `👋 <b>Welcome to AI Infra Digest Bot!</b>\n\n` +
      `I deliver daily AI infrastructure news at 8 AM MYT.\n\n` +
      `<b>Commands:</b>\n` +
      `• /digest — Run and receive the latest digest now\n` +
      `• /sources — List all tracked RSS feeds\n` +
      `• /last — Show the most recent digest summary\n` +
      `• /settings — View your preferences\n` +
      `• /watchlist — Manage your ticker watchlist\n` +
      `• /help — Show this message again\n\n` +
      `<i>Tip: I'll also auto-deliver the daily digest at 8 AM MYT!</i>`;

    await pollingBot.sendMessage(chatId, text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });

    // Register/update user in Supabase
    await upsertUser(msg);
  });

  // Handle /help
  pollingBot.onText(/^\/help(@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    const text =
      `🤖 <b>AI Infra Digest — Help</b>\n\n` +
      `I analyze AI infrastructure news and deliver insights.\n\n` +
      `<b>Commands:</b>\n` +
      `• /start — Welcome & intro\n` +
      `• /digest — Generate and send the latest digest now\n` +
      `• /sources — Show all 57 tracked RSS feeds\n` +
      `• /last — Show the most recent digest summary\n` +
      `• /settings — View your user preferences\n` +
      `• /watchlist <code>NVDA,AMD,AVGO</code> — Set your ticker watchlist\n` +
      `• /help — This message\n\n` +
      `<b>About:</b>\n` +
      `• Covers AI infra across 10 sectors (chips → power → data centers)\n` +
      `• Tracks 32+ key tickers\n` +
      `• Runs daily at 8 AM Malaysia time\n` +
      `• Powered by Llama 3.3 via Groq\n\n` +
      `<i>Built by AI | Not financial advice</i>`;

    await pollingBot.sendMessage(chatId, text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  });

  // Handle /digest — route to registered handler
  pollingBot.onText(/^\/digest(@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    const handler = handlers.get("digest");
    if (handler) {
      await pollingBot.sendMessage(chatId, "⏳ Generating your digest...");
      try {
        const result = await handler({
          chatId,
          username: msg.from?.username,
          firstName: msg.from?.first_name,
          text: msg.text || "",
        });
        const reply = typeof result === "string" ? { text: result } : result;
        await pollingBot.sendMessage(chatId, reply.text, {
          parse_mode: (reply.parseMode || "HTML") as "HTML",
          disable_web_page_preview: true,
        });
      } catch (error) {
        await pollingBot.sendMessage(
          chatId,
          `❌ Failed to generate digest: ${(error as Error).message}`,
          { parse_mode: "HTML" }
        );
      }
    } else {
      await pollingBot.sendMessage(chatId, "⚠️ Digest command not available right now.");
    }
  });

  // Handle /sources — route to registered handler
  pollingBot.onText(/^\/sources(@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    const handler = handlers.get("sources");
    if (handler) {
      try {
        const result = await handler({
          chatId,
          username: msg.from?.username,
          firstName: msg.from?.first_name,
          text: msg.text || "",
        });
        const reply = typeof result === "string" ? { text: result } : result;
        await pollingBot.sendMessage(chatId, reply.text, {
          parse_mode: (reply.parseMode || "HTML") as "HTML",
          disable_web_page_preview: true,
        });
      } catch (error) {
        await pollingBot.sendMessage(
          chatId,
          `❌ Failed: ${(error as Error).message}`,
          { parse_mode: "HTML" }
        );
      }
    }
  });

  // Handle /last — route to registered handler
  pollingBot.onText(/^\/last(@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    const handler = handlers.get("last");
    if (handler) {
      try {
        const result = await handler({
          chatId,
          username: msg.from?.username,
          firstName: msg.from?.first_name,
          text: msg.text || "",
        });
        const reply = typeof result === "string" ? { text: result } : result;
        await pollingBot.sendMessage(chatId, reply.text, {
          parse_mode: (reply.parseMode || "HTML") as "HTML",
          disable_web_page_preview: true,
        });
      } catch (error) {
        await pollingBot.sendMessage(
          chatId,
          `❌ Failed: ${(error as Error).message}`,
          { parse_mode: "HTML" }
        );
      }
    }
  });

  // Handle /settings
  pollingBot.onText(/^\/settings(@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    const { supabase } = await import("../utils/supabase");
    const prefs = await supabase.getUserPreferences(chatId);
    if (prefs) {
      const watchlist = prefs.watchlist?.length
        ? prefs.watchlist.join(", ")
        : "None set";
      const cats = prefs.categories_enabled?.length
        ? prefs.categories_enabled.join(", ")
        : "All";
      const text =
        `⚙️ <b>Your Settings</b>\n\n` +
        `• Watchlist: <code>${watchlist}</code>\n` +
        `• Categories: ${cats}\n` +
        `• Min impact score: ${prefs.min_impact_score ?? 0}/10\n` +
        `• Preferred time: ${prefs.preferred_time || "08:00"} ${prefs.timezone || "Asia/Kuala_Lumpur"}\n` +
        `• Active: ${prefs.is_active ? "✅" : "❌"}\n\n` +
        `<i>Use /watchlist NVDA,AMD,AVGO to update your watchlist</i>`;
      await pollingBot.sendMessage(chatId, text, { parse_mode: "HTML" });
    } else {
      await pollingBot.sendMessage(
        chatId,
        "ℹ️ No custom settings yet. Use /start to register.\n\nDefault settings:\n• Watchlist: None\n• Time: 08:00 MYT\n• All categories enabled",
        { parse_mode: "HTML" }
      );
    }
  });

  // Handle /watchlist
  pollingBot.onText(/^\/watchlist(@\w+)?\s*(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const tickersStr = match?.[2]?.trim();
    if (!tickersStr) {
      await pollingBot.sendMessage(
        chatId,
        "Usage: /watchlist <b>NVDA,AMD,AVGO</b>\n\nSet your favorite tickers to highlight in daily digests.",
        { parse_mode: "HTML" }
      );
      return;
    }
    const tickers = tickersStr
      .toUpperCase()
      .split(/[,; ]+/)
      .filter(Boolean);
    const { supabase } = await import("../utils/supabase");
    const ok = await supabase.upsertUserPreferences({
      chat_id: chatId,
      watchlist: tickers,
    });
    if (ok) {
      await pollingBot.sendMessage(
        chatId,
        `✅ Watchlist updated: <code>${tickers.join(", ")}</code>\n\nI'll highlight these tickers in your daily digest.`,
        { parse_mode: "HTML" }
      );
    } else {
      await pollingBot.sendMessage(
        chatId,
        "⚠️ Couldn't save watchlist (Supabase not configured). Your preferences will be used for this session only.",
        { parse_mode: "HTML" }
      );
    }
  });

  // Handle any unrecognized command
  pollingBot.onText(/^\//, async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text?.toLowerCase() || "";
    const knownCommands = ["/start", "/help", "/digest", "/sources", "/last", "/settings", "/watchlist", "/alert"];
    const isKnown = knownCommands.some((cmd) => text.startsWith(cmd));
    if (!isKnown) {
      await pollingBot.sendMessage(
        chatId,
        `❓ Unknown command. Try /help for available commands.`,
        { parse_mode: "HTML" }
      );
    }
  });

  logger.info("Telegram bot polling started — interactive commands ready");
}

async function upsertUser(msg: TelegramBot.Message): Promise<void> {
  try {
    const { supabase } = await import("../utils/supabase");
    await supabase.upsertUserPreferences({
      chat_id: msg.chat.id,
      username: msg.from?.username,
      first_name: msg.from?.first_name,
      is_active: true,
    });
  } catch {
    // Non-critical — fail silently
  }
}

// ─── Send Functions (unchanged from before) ────────────

export async function sendTelegramMessage(
  text: string,
  parseMode: "HTML" | "MarkdownV2" = "HTML"
): Promise<SendResult> {
  const bot = getBot();

  try {
    const result = await bot.sendMessage(config.telegram.chatId, text, {
      parse_mode: parseMode,
      disable_web_page_preview: false,
    });

    logger.info(`Telegram message sent (ID: ${result.message_id})`);
    return { success: true, messageId: result.message_id };
  } catch (error) {
    const errMsg = (error as Error).message;

    if (errMsg.includes("chat not found")) {
      logger.error(
        "Chat not found. Make sure you've messaged your bot first or correct TELEGRAM_CHAT_ID"
      );
    } else if (errMsg.includes("bot was blocked")) {
      logger.error("Bot was blocked by the user. Unblock and try again.");
    } else if (errMsg.includes("too long")) {
      logger.error("Message too long for Telegram. Try reducing articles.");
    }

    return { success: false, error: errMsg };
  }
}

export async function sendDigestMessage(
  digestText: string
): Promise<SendResult> {
  logger.info("Sending digest to Telegram...");

  if (digestText.length <= 4096) {
    return sendTelegramMessage(digestText);
  }

  const chunks = splitMessage(digestText, 4096);
  let lastResult: SendResult = { success: true };

  for (let i = 0; i < chunks.length; i++) {
    const header = i === 0 ? "" : `📄 Part ${i + 1}/${chunks.length}\n\n`;
    lastResult = await sendTelegramMessage(header + chunks[i]);
    if (!lastResult.success) break;
  }

  return lastResult;
}

function splitMessage(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const line of text.split("\n")) {
    if (current.length + line.length + 1 > maxLen) {
      chunks.push(current.trim());
      current = "";
    }
    current += line + "\n";
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

// ─── Webhook Support ────────────────────────────────────

/**
 * Set up a Telegram webhook instead of long polling.
 *
 * Webhook is more reliable at scale and recommended for production bots.
 * Requires a public HTTPS endpoint (e.g., via Railway, Render, or your own server).
 *
 * Usage:
 *   const bot = getBot();
 *   await setupWebhook(bot, "https://your-domain.com/webhook");
 *
 * Then create an Express/Fastify server that receives POST /webhook
 * and calls bot.processUpdate(req.body).
 */
export async function setupWebhook(
  webhookUrl: string,
  options?: {
    maxConnections?: number;
    allowedUpdates?: string[];
    secretToken?: string;
  }
): Promise<boolean> {
  try {
    const b = getBot();
    // Stop polling first — prevents wasted getUpdates requests after webhook is set
    if (typeof b.stopPolling === "function") {
      await b.stopPolling().catch(() => logger.debug("stopPolling threw (bot may not have been polling)"));
    }
    // Delete any existing webhook, then set the new one
    await b.deleteWebHook();
    await b.setWebHook(webhookUrl, {
      max_connections: options?.maxConnections ?? 40,
      allowed_updates: options?.allowedUpdates ?? ["message", "callback_query"],
      secret_token: options?.secretToken,
    });

    const info = await b.getWebHookInfo();
    if (info.url === webhookUrl) {
      logger.info(`Telegram webhook set to ${webhookUrl} (${info.pending_update_count} pending)`);
      return true;
    }
    logger.warn(`Webhook set but URL mismatch: expected ${webhookUrl}, got ${info.url}`);
    return false;
  } catch (error) {
    logger.error(`Failed to set Telegram webhook: ${(error as Error).message}`);
    return false;
  }
}

/**
 * Switch from webhook back to polling (useful for local development).
 */
export async function switchToPolling(): Promise<void> {
  try {
    const b = getBot();
    await b.deleteWebHook();
    // The bot was already created with polling: true, so it will resume polling
    // after the webhook is deleted. We just need to wait a moment.
    await new Promise((r) => setTimeout(r, 1000));
    logger.info("Switched back to long polling mode");
  } catch (error) {
    logger.error(`Failed to switch to polling: ${(error as Error).message}`);
  }
}

/**
 * Get current webhook info for diagnostics.
 */
export async function getWebhookInfo(): Promise<{
  url: string;
  pendingUpdates: number;
  lastError?: string;
}> {
  const b = getBot();
  const info = await b.getWebHookInfo();
  return {
    url: info.url || "",
    pendingUpdates: info.pending_update_count || 0,
    lastError: info.last_error_message || undefined,
  };
}

// ─── Init ──────────────────────────────────────────────

/** Call once at startup to enable interactive commands. */
export function startInteractiveBot(): void {
  initCommands();
}

/**
 * Start the bot with webhook mode instead of polling.
 * Useful for production deployments where polling may be unreliable.
 *
 * @param webhookUrl - Public HTTPS URL where Telegram sends updates
 * @param options - Optional configuration
 */
export async function startWebhookBot(
  webhookUrl: string,
  options?: {
    maxConnections?: number;
    allowedUpdates?: string[];
    secretToken?: string;
  }
): Promise<void> {
  // Register commands first
  initCommands();

  // Then set up webhook
  const ok = await setupWebhook(webhookUrl, options);
  if (ok) {
    logger.info(`Webhook bot started at ${webhookUrl}`);
  } else {
    logger.warn("Webhook setup failed, falling back to polling");
  }
}
