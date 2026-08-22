import TelegramBot, { type Update, type Message, type InlineKeyboardButton } from "node-telegram-bot-api";
import { config } from "../config";
import { logger } from "../utils/logger";
import { emitCommandUsage } from "../utils/metrics";
import { supabase } from "../utils/supabase";
import { NEWS_CATEGORIES } from "../processor/ai";
import {
  startOnboarding,
  cancelOnboarding,
  handleOnboardingCallback,
  handleOnboardingText,
} from "../onboarding";
import { escapeHtml } from "../utils/escape";

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

type EditableSetting = "preferred_time" | "timezone" | "min_impact_score" | "digest_length" | "categories_enabled";

const SETTING_ALIASES: Record<string, EditableSetting> = {
  time: "preferred_time",
  preferred_time: "preferred_time",
  "preferred-time": "preferred_time",
  timezone: "timezone",
  tz: "timezone",
  min: "min_impact_score",
  score: "min_impact_score",
  min_score: "min_impact_score",
  "min-score": "min_impact_score",
  min_impact_score: "min_impact_score",
  length: "digest_length",
  digest_length: "digest_length",
  "digest-length": "digest_length",
  categories: "categories_enabled",
  category: "categories_enabled",
};

const DIGEST_LENGTHS = ["brief", "standard", "detailed"] as const;
const CATEGORY_BY_NAME = new Map(
  NEWS_CATEGORIES.map((category) => [category.toLowerCase(), category])
);

function settingsHelpText(): string {
  return (
    `⚙️ <b>Settings commands</b>\n\n` +
    `• <code>/settings time 08:00</code> — Preferred delivery time\n` +
    `• <code>/settings timezone Asia/Kuala_Lumpur</code> — IANA timezone\n` +
    `• <code>/settings min_score 5</code> — Minimum impact score (0–10)\n` +
    `• <code>/settings length standard</code> — brief, standard, or detailed\n` +
    `• <code>/settings categories Chips &amp; GPUs, Datacenters</code> — Filter categories\n` +
    `• <code>/settings categories all</code> — Enable all categories\n\n` +
    `Use <code>/settings</code> without arguments to view your current settings.`
  );
}

function isValidPreferredTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function isValidIanaTimezone(value: string): boolean {
  if (!value || value.length > 100 || /\s/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

/** Returns null for invalid input; an empty array means all categories. */
function parseCategories(value: string): string[] | null {
  if (value.toLowerCase() === "all") return [];

  const rawCategories = value.split(/[,;]/).map((category) => category.trim());
  if (!rawCategories.length || rawCategories.some((category) => !category)) return null;

  const categories: string[] = [];
  for (const rawCategory of rawCategories) {
    const category = CATEGORY_BY_NAME.get(rawCategory.toLowerCase());
    if (!category || categories.includes(category)) return null;
    categories.push(category);
  }
  return categories;
}

function parseSettingsArgs(args: string): { setting?: EditableSetting; value: string } {
  const match = /^([^\s=]+)(?:=|\s+)?([\s\S]*)$/.exec(args.trim());
  if (!match) return { value: "" };

  const key = SETTING_ALIASES[match[1].toLowerCase()];
  return { setting: key, value: match[2].trim() };
}

function formatSettings(prefs: NonNullable<Awaited<ReturnType<typeof supabase.getUserPreferences>>>): string {
  const watchlist = prefs.watchlist?.length ? prefs.watchlist.join(", ") : "None set";
  const categories = prefs.categories_enabled?.length ? prefs.categories_enabled.join(", ") : "All";
  const deliveryCopies = [
    prefs.delivery_email ? "Email" : null,
    prefs.slack_webhook_url ? "Slack" : null,
  ].filter(Boolean).join(", ") || "None";

  return (
    `⚙️ <b>Your Settings</b>\n\n` +
    `• Watchlist: <code>${escapeHtml(watchlist)}</code>\n` +
    `• Categories: ${escapeHtml(categories)}\n` +
    `• Min impact score: ${escapeHtml(String(prefs.min_impact_score ?? 0))}/10\n` +
    `• Preferred time: ${escapeHtml(prefs.preferred_time || "08:00")} ${escapeHtml(prefs.timezone || "Asia/Kuala_Lumpur")}\n` +
    `• Digest length: ${escapeHtml(prefs.digest_length || "standard")}\n` +
    `• Delivery copies: ${escapeHtml(deliveryCopies)}\n` +
    `• Active: ${prefs.is_active ? "✅" : "❌"}\n\n` +
    `${settingsHelpText()}`
  );
}

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

  // Handle /stop and /unsubscribe — explicit opt-out from scheduled delivery.
  pollingBot.onText(/^\/(?:stop|unsubscribe)(@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    const command = (msg.text || "/stop")
      .split(/\s+/)[0]
      .replace(/^\//, "")
      .replace(/@\w+$/, "")
      .toLowerCase();
    logCommandUse(command, chatId);
    cancelOnboarding(chatId);

    let deactivated = false;
    try {
      deactivated = await supabase.upsertUserPreferences({
        chat_id: chatId,
        is_active: false,
      });
    } catch (error) {
      logger.warn(`Failed to stop delivery for ${chatId}: ${(error as Error).message}`);
    }

    await pollingBot.sendMessage(
      chatId,
      deactivated
        ? `🛑 <b>Delivery stopped</b>\n\nYou won't receive scheduled digests. Send /resume to continue with your saved preferences, or /start to set up again.`
        : `⚠️ I couldn't update your delivery status. Please try /stop again.`,
      { parse_mode: "HTML" }
    );
  });

  // Handle /resume — reactivate only after a previously completed onboarding.
  pollingBot.onText(/^\/resume(@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    logCommandUse("resume", chatId);
    cancelOnboarding(chatId);

    let resumed = false;
    try {
      const prefs = await supabase.getUserPreferences(chatId);
      if (prefs?.onboarding_completed_at) {
        resumed = await supabase.upsertUserPreferences({
          chat_id: chatId,
          is_active: true,
        });
        if (resumed) {
          await supabase.recordProductEvent("delivery_resumed", chatId);
        }
      }
    } catch (error) {
      logger.warn(`Failed to resume delivery for ${chatId}: ${(error as Error).message}`);
    }

    await pollingBot.sendMessage(
      chatId,
      resumed
        ? `✅ <b>Delivery resumed</b>\n\nYour saved schedule and preferences are active again. Use /settings to review them.`
        : `⚠️ I couldn't resume delivery. Send /start and complete setup to opt in.`,
      { parse_mode: "HTML" }
    );
  });

  // Handle /delete_my_data and /delete — remove private user data.
  pollingBot.onText(/^\/(?:delete_my_data|delete)(@\w+)?(?:\s+([\s\S]*))?$/, async (msg, match) => {
    const chatId = msg.chat.id;

    // Do not record this command in command_usage: the usage row is private
    // data and a fire-and-forget log could be inserted after deletion.
    cancelOnboarding(chatId);

    if (match?.[2]?.trim()) {
      await pollingBot.sendMessage(
        chatId,
        "Usage: <code>/delete_my_data</code> (or <code>/delete</code>) without additional arguments.",
        { parse_mode: "HTML" }
      );
      return;
    }

    let deleted = false;
    try {
      deleted = await supabase.deleteUserData(chatId);
    } catch (error) {
      logger.warn(`Failed to delete private data for ${chatId}: ${(error as Error).message}`);
    }

    await pollingBot.sendMessage(
      chatId,
      deleted
        ? "✅ Your private data was deleted and scheduled delivery was disabled. Shared articles and digest data were not affected. Send /start anytime to set up again."
        : "⚠️ I couldn't complete the private-data deletion. Please try again. Shared articles and digest data were not affected.",
      { parse_mode: "HTML" }
    );
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
      `• /delivery — Configure personalized email or Slack copies\n` +
      `• /settings — View or edit your user preferences\n` +
      `• /delete_my_data — Delete your private data (<code>/delete</code> also works)\n` +
      `• /watchlist <code>NVDA,AMD,AVGO</code> — Set your ticker watchlist\n` +
      `• /alert — Manage high-impact alerts\n` +
      `• /stop — Stop scheduled digest delivery (<code>/unsubscribe</code> also works)\n` +
      `• /resume — Resume delivery with your saved preferences\n` +
      `• /help — This message\n\n` +
      `<b>About:</b>\n` +
      `• Covers AI infra across 10 sectors (chips → power → data centers)\n` +
      `• Tracks 32+ key tickers\n` +
      `• One canonical edition is published daily; your copy follows your saved local time\n` +
      `• Provider-agnostic two-tier AI analysis\n\n` +
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
        logger.warn(`Digest command failed for ${chatId}: ${(error as Error).message}`);
        await pollingBot.sendMessage(
          chatId,
          "❌ The digest could not be generated right now. Please try again later.",
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
        logger.warn(`Feedback command failed for ${chatId}: ${(error as Error).message}`);
        await pollingBot.sendMessage(
          chatId,
          "❌ That request could not be completed right now. Please try again later.",
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

  // Handle /settings — bare command displays preferences; arguments update one field.
  pollingBot.onText(/^\/settings(@\w+)?(?:\s+([\s\S]*))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    logCommandUse("settings", chatId);
    const args = match?.[2]?.trim() || "";

    if (args) {
      const { setting, value } = parseSettingsArgs(args);
      let update: Parameters<typeof supabase.upsertUserPreferences>[0] | null = null;

      if (setting === "preferred_time" && isValidPreferredTime(value)) {
        update = { chat_id: chatId, preferred_time: value };
      } else if (setting === "timezone" && isValidIanaTimezone(value)) {
        update = { chat_id: chatId, timezone: value };
      } else if (setting === "min_impact_score" && /^(?:10|[0-9])$/.test(value)) {
        update = { chat_id: chatId, min_impact_score: Number(value) };
      } else if (setting === "digest_length" && DIGEST_LENGTHS.includes(value as (typeof DIGEST_LENGTHS)[number])) {
        update = { chat_id: chatId, digest_length: value as (typeof DIGEST_LENGTHS)[number] };
      } else if (setting === "categories_enabled") {
        const categories = parseCategories(value);
        if (categories) update = { chat_id: chatId, categories_enabled: categories };
      }

      if (!update) {
        await pollingBot.sendMessage(chatId, settingsHelpText(), { parse_mode: "HTML" });
        return;
      }

      let saved = false;
      try {
        saved = await supabase.upsertUserPreferences(update);
      } catch (error) {
        logger.warn(`Failed to update settings for ${chatId}: ${(error as Error).message}`);
      }

      if (!saved) {
        await pollingBot.sendMessage(chatId, "⚠️ Couldn't save that setting right now. Please try again.", { parse_mode: "HTML" });
        return;
      }

      const confirmation =
        update.preferred_time !== undefined
          ? `✅ Preferred delivery time set to <code>${escapeHtml(update.preferred_time)}</code>.`
          : update.timezone !== undefined
            ? `✅ Timezone set to <code>${escapeHtml(update.timezone)}</code>.`
            : update.min_impact_score !== undefined
              ? `✅ Minimum impact score set to <b>${update.min_impact_score}/10</b>.`
              : update.digest_length !== undefined
                ? `✅ Digest length set to <b>${escapeHtml(update.digest_length)}</b>.`
                : update.categories_enabled?.length
                  ? `✅ Categories set to <b>${escapeHtml(update.categories_enabled.join(", "))}</b>.`
                  : "✅ All categories enabled.";
      await pollingBot.sendMessage(chatId, confirmation, { parse_mode: "HTML" });
      return;
    }

    const prefs = await supabase.getUserPreferences(chatId);
    if (prefs) {
      await pollingBot.sendMessage(chatId, formatSettings(prefs), { parse_mode: "HTML" });
    } else {
      await pollingBot.sendMessage(
        chatId,
        "ℹ️ No custom settings yet. Use /start to register.\n\nDefault settings:\n• Watchlist: None\n• Time: 08:00 Asia/Kuala_Lumpur\n• Min impact score: 0/10\n• Digest length: standard\n• All categories enabled\n\n" + settingsHelpText(),
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
  const BESPOKE_COMMANDS = new Set([
    "start",
    "stop",
    "unsubscribe",
    "resume",
    "delete_my_data",
    "delete",
    "help",
    "digest",
    "settings",
    "watchlist",
    "feedback",
  ]);

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
      logger.warn(`Command ${key} failed for ${chatId}: ${(error as Error).message}`);
      await pollingBot.sendMessage(
        chatId,
        "❌ That request could not be completed right now. Please try again later.",
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
      is_active: false,
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
    const shortTitle = escapeHtml(a.title.length > 60 ? a.title.slice(0, 60) + "…" : a.title);
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

export function splitMessage(text: string, maxLen: number): string[] {
  if (!Number.isInteger(maxLen) || maxLen < 1) {
    throw new RangeError("maxLen must be a positive integer");
  }

  const chunks: string[] = [];
  let current = "";

  for (const line of text.split("\n")) {
    if (line.length > maxLen) {
      if (current) {
        chunks.push(current);
        current = "";
      }

      let remaining = line;
      while (remaining.length > maxLen) {
        chunks.push(remaining.slice(0, maxLen));
        remaining = remaining.slice(maxLen);
      }
      current = remaining;
      continue;
    }

    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxLen) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current) {
    chunks.push(current);
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
