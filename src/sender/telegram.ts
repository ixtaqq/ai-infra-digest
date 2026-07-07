import TelegramBot, { type Update, type Message, type InlineKeyboardButton } from "node-telegram-bot-api";
import { config } from "../config";
import { logger } from "../utils/logger";
import { emitCommandUsage } from "../utils/metrics";
import { startOnboarding, handleOnboardingCallback, handleOnboardingText } from "../onboarding";

let bot: TelegramBot | null = null;
let commandHandlersRegistered = false;
let useWebhook = false;

/**
 * Switch the (lazily-created) bot into webhook mode — it will be created with
 * polling disabled. MUST be called before the first getBot()/startInteractiveBot()
 * call (i.e., at the very top of the webhook server entry point). In webhook mode,
 * updates are fed in via {@link handleWebhookUpdate} instead of long polling.
 */
export function enableWebhookMode(): void {
  useWebhook = true;
}

function getBot(): TelegramBot {
  if (!bot) {
    // Polling for local/CI runs; disabled in webhook mode so a serverless or
    // always-on host can push updates via processUpdate(). A non-polling bot can
    // still send outgoing messages via sendMessage().
    bot = new TelegramBot(config.telegram.botToken, useWebhook ? { polling: false } : { polling: true });
  }
  return bot;
}

/**
 * Feed a raw Telegram update (a webhook POST body) to the bot's registered
 * command handlers. Call enableWebhookMode() + startInteractiveBot() first.
 */
export function handleWebhookUpdate(update: Update): void {
  getBot().processUpdate(update);
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

/**
 * Record that a user invoked a bot command (v13). Fire-and-forget on both legs:
 * NDJSON metrics (local/ephemeral) + a durable Supabase row. Never throws — a
 * usage-logging failure must never affect the command the user actually ran.
 */
function logCommandUse(command: string, chatId: number): void {
  try {
    emitCommandUsage(command, chatId);
  } catch {
    /* non-critical */
  }
  import("../utils/supabase")
    .then(({ supabase }) => supabase.logCommandUsage(command, chatId))
    .catch(() => {
      /* non-critical — durable log is best-effort */
    });
}

function initCommands() {
  if (commandHandlersRegistered) return;
  commandHandlersRegistered = true;

  const pollingBot = getBot();

  // Handle /start — launches interactive onboarding flow
  pollingBot.onText(/^\/start(@\w+)?$/, async (msg) => {
    logCommandUse("start", msg.chat.id);
    await startOnboarding(pollingBot, msg);
  });

  // Route callback queries — onboarding steps first, then other handlers
  pollingBot.on("callback_query", async (query) => {
    const handled = await handleOnboardingCallback(pollingBot, query);
    if (handled) return;
    // other callback handlers can be added here
  });

  // Route free-text messages during onboarding (watchlist input)
  pollingBot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;
    await handleOnboardingText(pollingBot, msg);
  });

  // Handle /help
  pollingBot.onText(/^\/help(@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    logCommandUse("help", chatId);
    const text =
      `🤖 <b>AI Infra Digest — Help</b>\n\n` +
      `I analyze AI infrastructure news and deliver insights.\n\n` +
      `<b>Commands:</b>\n` +
      `• /start — Welcome & intro\n` +
      `• /digest — Show recent stored articles (<code>/digest watchlist</code> or <code>/digest sector=Chips_&_GPUs</code> to filter)\n` +
      `• /sources — Show all 68 tracked RSS feeds (<code>/sources quality</code> for trust scores)\n` +
      `• /last — Show the most recent digest summary\n` +
      `• /trending — See what's trending in AI infra\n` +
      `• /trends <code>NVDA 30d</code> — Sparkline + WoW delta for a ticker or sector\n` +
      `• /sec <code>NVDA</code> — Latest SEC filing highlights for a ticker\n` +
      `• /coverage <code>NVDA 14</code> — Recent coverage history for a ticker\n` +
      `• /thesis <code>NVDA</code> — Bull/bear thesis timeline for a ticker\n` +
      `• /watch <code>NVDA 130</code> — One-shot price ping (<code>off</code> to clear, <code>list</code> to view)\n` +
      `• /feedback N — Rate today's digest (1-5)\n` +
      `• /settings — View your user preferences\n` +
      `• /watchlist <code>NVDA,AMD,AVGO</code> — Set your ticker watchlist\n` +
      `• /alert — Manage high-impact alerts\n` +
      `• /help — This message\n\n` +
      `<b>About:</b>\n` +
      `• Covers AI infra across 10 sectors (chips → power → data centers)\n` +
      `• Tracks 32+ key tickers\n` +
      `• Runs daily at 8 AM Malaysia time\n` +
      `• Powered by Llama 3.3 via Groq\n\n` +
      `<i>Built by AI | Not financial advice</i>`;

    await pollingBot.sendMessage(chatId, text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });

  // Handle /digest — route to registered handler. Args pass through in msg.text
  // (the handler parses "watchlist" / "sector=X" itself); kept bespoke rather than
  // using the generic dispatcher below only for the "Generating..." pre-message.
  pollingBot.onText(/^\/digest(@\w+)?(\s+.*)?$/, async (msg) => {
    const chatId = msg.chat.id;
    logCommandUse("digest", chatId);
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
          link_preview_options: { is_disabled: true },
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

  // Handle /feedback — route to registered handler with inline keyboard
  pollingBot.onText(/^\/feedback(@\w+)?(\s+.*)?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    logCommandUse("feedback", chatId);
    const handler = handlers.get("feedback");
    if (handler) {
      try {
        const fullText = msg.text || "";
        // Check if there's a rating already in the text
        const parts = fullText.split(/\s+/).slice(1);
        const hasInlineRating = parts.length > 0 && /^[1-5]$/.test(parts[0]);

        if (!hasInlineRating) {
          // Show inline keyboard for quick rating
          const inlineKeyboard = {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "⭐ 1", callback_data: "feedback_1" },
                  { text: "⭐ 2", callback_data: "feedback_2" },
                  { text: "⭐ 3", callback_data: "feedback_3" },
                  { text: "⭐ 4", callback_data: "feedback_4" },
                  { text: "⭐ 5", callback_data: "feedback_5" },
                ],
                [
                  { text: "📝 Add comment (use /feedback 5 Your comment)", callback_data: "feedback_help" },
                ],
              ],
            },
          };

          const bot = getBot();
          await bot.sendMessage(
            chatId,
            `💬 <b>Rate Today's Digest</b>\n\nHow would you rate today's digest?`,
            {
              parse_mode: "HTML",
              ...inlineKeyboard,
            }
          );
        } else {
          const result = await handler({
            chatId,
            username: msg.from?.username,
            firstName: msg.from?.first_name,
            text: fullText,
          });
          const reply = typeof result === "string" ? { text: result } : result;
          await pollingBot.sendMessage(chatId, reply.text, {
            parse_mode: (reply.parseMode || "HTML") as "HTML",
            link_preview_options: { is_disabled: true },
          });
        }
      } catch (error) {
        await pollingBot.sendMessage(
          chatId,
          `❌ Failed: ${(error as Error).message}`,
          { parse_mode: "HTML" }
        );
      }
    }
  });

  // Handle callback queries from inline keyboards
  pollingBot.on("callback_query", async (query) => {
    const chatId = query.message?.chat?.id;
    const data = query.data || "";
    if (!chatId) return;

    // Handle article validation callbacks (👍/👎 buttons) — answer with toast
    if (data.startsWith("va_")) {
      // callback_data format: "va_{article_id}_{up|dn}"
      const parts = data.split("_");
      const articleId = parseInt(parts[1], 10);
      const dir = parts[2];
      if (!isNaN(articleId) && (dir === "up" || dir === "dn")) {
        const isNew = await handleArticleValidation(chatId, articleId, dir === "up" ? "up" : "down");
        try {
          await pollingBot.answerCallbackQuery(query.id, {
            text: isNew ? (dir === "up" ? "Thanks! 👍" : "Thanks! 👎") : "Already rated!",
            show_alert: false,
          });
        } catch {/* non-critical */}
      } else {
        try { await pollingBot.answerCallbackQuery(query.id); } catch {/* */}
      }
      return;
    }

    // Acknowledge all other callback queries (removes loading state on the button)
    try {
      await pollingBot.answerCallbackQuery(query.id);
    } catch {
      // Non-critical
    }

    // Handle feedback callbacks
    if (data.startsWith("feedback_")) {
      const ratingStr = data.replace("feedback_", "");
      if (ratingStr === "help") {
        await pollingBot.sendMessage(
          chatId,
          `💬 <b>Adding a Comment</b>\n\nUse <code>/feedback 5 Your comment here</code>\n\nExample: <code>/feedback 4 Great NVIDIA coverage but too many power articles</code>`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const rating = parseInt(ratingStr, 10);
      if (rating >= 1 && rating <= 5) {
        const handler = handlers.get("feedback");
        if (handler) {
          const result = await handler({
            chatId,
            username: query.from?.username,
            firstName: query.from?.first_name,
            text: `/feedback ${rating}`,
          });
          const reply = typeof result === "string" ? { text: result } : result;
          await pollingBot.sendMessage(chatId, reply.text, {
            parse_mode: (reply.parseMode || "HTML") as "HTML",
            link_preview_options: { is_disabled: true },
          });
        }
      }
    }
  });

  // Handle /settings
  pollingBot.onText(/^\/settings(@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    logCommandUse("settings", chatId);
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
    logCommandUse("watchlist", chatId);
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

  // ─── Generic command dispatcher ──────────────────────
  // Routes every registerCommand()-registered handler without a hand-written
  // onText block per command. Before this existed, only commands with explicit
  // blocks above were reachable — /sec, /trends, /thesis, /alert, /coverage and
  // /watch were registered but silently undispatchable from the live bot.
  //
  // Commands with bespoke onText handlers above are skipped here so they don't
  // get double-handled (node-telegram-bot-api fires every matching onText).
  const BESPOKE_COMMANDS = new Set(["start", "help", "digest", "settings", "watchlist", "feedback"]);

  pollingBot.onText(/^\/(\S+)([\s\S]*)$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const rawCmd = (match?.[1] || "").replace(/@\w+$/, "").toLowerCase();
    if (!rawCmd || BESPOKE_COMMANDS.has(rawCmd)) return;

    // Longest-prefix match so multi-word registrations ("sources quality")
    // win over their one-word parent ("sources").
    const firstArg = (match?.[2] || "").trim().split(/\s+/)[0]?.toLowerCase();
    const key =
      firstArg && handlers.has(`${rawCmd} ${firstArg}`)
        ? `${rawCmd} ${firstArg}`
        : handlers.has(rawCmd)
          ? rawCmd
          : null;

    if (!key) {
      await pollingBot.sendMessage(
        chatId,
        `❓ Unknown command. Try /help for available commands.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // Log the resolved key so "sources quality" is counted distinctly from "sources".
    logCommandUse(key, chatId);

    try {
      const result = await handlers.get(key)!({
        chatId,
        username: msg.from?.username,
        firstName: msg.from?.first_name,
        text: msg.text || "",
      });
      const reply = typeof result === "string" ? { text: result } : result;
      await pollingBot.sendMessage(chatId, reply.text, {
        parse_mode: (reply.parseMode || "HTML") as "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      await pollingBot.sendMessage(
        chatId,
        `❌ Failed: ${(error as Error).message}`,
        { parse_mode: "HTML" }
      );
    }
  });

  logger.info(
    useWebhook
      ? "Telegram command handlers registered — webhook mode (updates via processUpdate)"
      : "Telegram bot polling started — interactive commands ready"
  );
}

async function upsertUser(msg: Message): Promise<void> {
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

// ─── Admin Alert ───────────────────────────────────────

/**
 * Send a plain-text alert to the configured admin chat. Fire-and-forget;
 * caller is responsible for catching rejections if needed.
 */
export async function sendAdminAlert(text: string): Promise<void> {
  const b = getBot();
  await b.sendMessage(config.telegram.chatId, text, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

// ─── Article Validation Follow-Up ──────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Send a compact 👍/👎 validation message for the top-3 articles immediately
 * after digest delivery. Requires article IDs from Supabase (url → id map).
 * Non-critical — caller must handle errors.
 */
export async function sendValidationFollowUp(
  chatId: number,
  articles: { title: string; url: string; impactScore: number; effectiveScore?: number }[],
  articleIds: Map<string, number>
): Promise<void> {
  const candidates = articles
    .filter((a) => a.url && articleIds.has(a.url))
    .sort((a, b) => (b.effectiveScore ?? b.impactScore) - (a.effectiveScore ?? a.impactScore))
    .slice(0, 3);

  if (!candidates.length) return;

  const lines = ["<b>&#128202; Quick Validation</b>", "<i>Was the AI analysis accurate?</i>", ""];
  const keyboard: InlineKeyboardButton[][] = [];

  candidates.forEach((a, i) => {
    const id = articleIds.get(a.url)!;
    const shortTitle = escHtml(a.title.length > 60 ? a.title.slice(0, 60) + "…" : a.title);
    lines.push(`${i + 1}. ${shortTitle}`);
    keyboard.push([
      { text: `${i + 1} 👍`, callback_data: `va_${id}_up` },
      { text: `${i + 1} 👎`, callback_data: `va_${id}_dn` },
    ]);
  });

  const bot = getBot();
  await bot.sendMessage(chatId, lines.join("\n"), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: keyboard },
  });
}

/**
 * Record a 👍/👎 vote for an article. Idempotent — duplicate votes (same
 * chat_id + article_id) are silently ignored. Returns true if the vote was
 * new, false if the user already voted.
 */
async function handleArticleValidation(
  chatId: number,
  articleId: number,
  rating: "up" | "down"
): Promise<boolean> {
  const url = config.app.supabaseUrl;
  const key = config.app.supabaseServiceKey;
  if (!url || !key) return false;

  const headers = {
    "apikey": key,
    "Authorization": `Bearer ${key}`,
    "Content-Type": "application/json",
    "Prefer": "return=minimal,resolution=ignore-duplicates",
  };

  // Insert vote (duplicate silently ignored by ignore-duplicates)
  const insertRes = await fetch(
    `${url}/rest/v1/article_validations?on_conflict=article_id,chat_id`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ article_id: articleId, chat_id: chatId, rating }),
    }
  );

  // 201 = new row; 200 with empty body = duplicate ignored
  const isNew = insertRes.status === 201;
  if (!insertRes.ok && insertRes.status !== 200 && insertRes.status !== 201) {
    logger.warn(`article_validations insert: HTTP ${insertRes.status}`);
    return false;
  }

  if (isNew) {
    // Increment the aggregate counter on the articles row (GET current → PATCH +1)
    const col = rating === "up" ? "thumbs_up" : "thumbs_down";
    try {
      const getRes = await fetch(
        `${url}/rest/v1/articles?id=eq.${articleId}&select=${col}`,
        { headers: { "apikey": key, "Authorization": `Bearer ${key}` } }
      );
      if (getRes.ok) {
        const rows = (await getRes.json()) as Record<string, number>[];
        const current = rows[0]?.[col] ?? 0;
        await fetch(`${url}/rest/v1/articles?id=eq.${articleId}`, {
          method: "PATCH",
          headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json", "Prefer": "return=minimal" },
          body: JSON.stringify({ [col]: current + 1 }),
        });
      }
    } catch {/* non-critical */}
  }

  return isNew;
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

/**
 * Send a digest message to a specific user chat, rather than the default chat.
 * Used for per-user scheduled delivery.
 */
export async function sendDigestMessageToUser(
  chatId: number,
  text: string,
  parseMode: "HTML" | "MarkdownV2" = "HTML"
): Promise<SendResult> {
  const b = getBot();

  try {
    if (text.length <= 4096) {
      const result = await b.sendMessage(chatId, text, {
        parse_mode: parseMode,
  
      });
      logger.info(`Digest sent to user ${chatId} (ID: ${result.message_id})`);
      return { success: true, messageId: result.message_id };
    }

    // Chunk long messages
    const chunks = splitMessage(text, 4096);
    let lastResult: SendResult = { success: true };

    for (let i = 0; i < chunks.length; i++) {
      const header = i === 0 ? "" : `📄 Part ${i + 1}/${chunks.length}\n\n`;
      const result = await b.sendMessage(chatId, header + chunks[i], {
        parse_mode: parseMode,
  
      });
      lastResult = { success: true, messageId: result.message_id };
    }

    logger.info(`Digest sent to user ${chatId} in ${chunks.length} parts`);
    return lastResult;
  } catch (error) {
    const errMsg = (error as Error).message;
    logger.error(`Failed to send digest to user ${chatId}: ${errMsg}`);
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
