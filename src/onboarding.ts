/**
 * Interactive user onboarding flow.
 *
 * State machine: Welcome → DeliveryTime → Watchlist → MinScore → DigestLength → Done
 * State is held in-memory (ephemeral). If the server restarts mid-flow the
 * user just gets a clean /start again — no data loss, no broken state.
 */

import TelegramBot, { type InlineKeyboardMarkup, type Message, type CallbackQuery } from "node-telegram-bot-api";
import { supabase } from "./utils/supabase";
import { logger } from "./utils/logger";

type OnboardingStep = "delivery_time" | "watchlist" | "min_score" | "digest_length" | "done";

interface OnboardingState {
  step: OnboardingStep;
  firstName: string;
  deliveryTime?: string;
  watchlist?: string[];
  minScore?: number;
  digestLength?: "brief" | "standard" | "detailed";
  promptMessageId?: number;
}

const sessions = new Map<number, OnboardingState>();

// ── Inline keyboard helpers ──────────────────────────────────────────────────

function timeKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "7:00 AM", callback_data: "ob_time_07:00" },
        { text: "8:00 AM ⭐", callback_data: "ob_time_08:00" },
        { text: "9:00 AM", callback_data: "ob_time_09:00" },
      ],
      [
        { text: "10:00 AM", callback_data: "ob_time_10:00" },
        { text: "6:00 PM", callback_data: "ob_time_18:00" },
        { text: "Skip →", callback_data: "ob_time_skip" },
      ],
    ],
  };
}

function scoreKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "All news (default)", callback_data: "ob_score_0" },
        { text: "Medium+ (5+)", callback_data: "ob_score_5" },
      ],
      [
        { text: "High only (8+)", callback_data: "ob_score_8" },
        { text: "Skip →", callback_data: "ob_score_0" },
      ],
    ],
  };
}

function lengthKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "Brief (headline + 1 line)", callback_data: "ob_len_brief" },
        { text: "Standard ⭐", callback_data: "ob_len_standard" },
      ],
      [
        { text: "Detailed (full summaries)", callback_data: "ob_len_detailed" },
        { text: "Skip →", callback_data: "ob_len_standard" },
      ],
    ],
  };
}

// ── Step renderers ───────────────────────────────────────────────────────────

async function sendTimeStep(bot: TelegramBot, chatId: number, firstName: string) {
  const msg = await bot.sendMessage(
    chatId,
    `⏰ <b>Step 1/4 — Delivery time</b>\n\n` +
      `Hi ${firstName}! When do you want your daily AI infra digest?\n\n` +
      `<i>All times are in Malaysia Time (MYT, UTC+8).</i>`,
    { parse_mode: "HTML", reply_markup: timeKeyboard() }
  );
  const state = sessions.get(chatId)!;
  state.promptMessageId = msg.message_id;
}

async function sendWatchlistStep(bot: TelegramBot, chatId: number) {
  const msg = await bot.sendMessage(
    chatId,
    `📈 <b>Step 2/4 — Ticker watchlist</b>\n\n` +
      `Which stocks do you track? I'll highlight articles mentioning these tickers and float them to the top of your digest.\n\n` +
      `Reply with comma-separated tickers, e.g.:\n<code>NVDA, AMD, AVGO, MSFT</code>\n\n` +
      `Or tap <b>Skip</b> to receive the full digest without filtering.`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "Skip →", callback_data: "ob_watchlist_skip" }]],
      },
    }
  );
  const state = sessions.get(chatId)!;
  state.step = "watchlist";
  state.promptMessageId = msg.message_id;
}

async function sendScoreStep(bot: TelegramBot, chatId: number) {
  const msg = await bot.sendMessage(
    chatId,
    `🎯 <b>Step 3/4 — Impact filter</b>\n\n` +
      `Articles are scored 1–10 by AI based on market impact.\n\n` +
      `• <b>All news</b> — receive everything (recommended to start)\n` +
      `• <b>Medium+ (5+)</b> — skip low-signal noise\n` +
      `• <b>High only (8+)</b> — only major market-moving news`,
    { parse_mode: "HTML", reply_markup: scoreKeyboard() }
  );
  const state = sessions.get(chatId)!;
  state.step = "min_score";
  state.promptMessageId = msg.message_id;
}

async function sendLengthStep(bot: TelegramBot, chatId: number) {
  const msg = await bot.sendMessage(
    chatId,
    `📝 <b>Step 4/4 — Digest length</b>\n\n` +
      `How much detail do you want in each article summary?\n\n` +
      `• <b>Brief</b> — headline + one line (great for a quick scan)\n` +
      `• <b>Standard</b> — full summary, key stocks, and reason (default)\n` +
      `• <b>Detailed</b> — everything, including analysis rationale`,
    { parse_mode: "HTML", reply_markup: lengthKeyboard() }
  );
  const state = sessions.get(chatId)!;
  state.step = "digest_length";
  state.promptMessageId = msg.message_id;
}

async function sendConfirmation(bot: TelegramBot, chatId: number, state: OnboardingState) {
  const watchlistStr =
    state.watchlist && state.watchlist.length > 0
      ? state.watchlist.join(", ")
      : "None (full digest)";
  const scoreStr =
    state.minScore && state.minScore > 0 ? `${state.minScore}+/10` : "All (no filter)";
  const lengthStr = state.digestLength || "standard";

  await bot.sendMessage(
    chatId,
    `✅ <b>You're all set!</b>\n\n` +
      `<b>Your preferences:</b>\n` +
      `• Delivery time: <code>${state.deliveryTime || "08:00"} MYT</code>\n` +
      `• Watchlist: <code>${watchlistStr}</code>\n` +
      `• Min impact score: <code>${scoreStr}</code>\n` +
      `• Digest length: <code>${lengthStr}</code>\n\n` +
      `Your personalised digest will arrive daily at the time above.\n\n` +
      `<i>Change anytime with /settings, /watchlist, or /alert threshold.</i>`,
    { parse_mode: "HTML" }
  );
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Start the onboarding flow for a new /start. */
export async function startOnboarding(
  bot: TelegramBot,
  msg: Message
): Promise<void> {
  const chatId = msg.chat.id;
  const firstName = msg.from?.first_name || "there";

  // Upsert user immediately so they exist even if they abandon onboarding
  await supabase.upsertUserPreferences({
    chat_id: chatId,
    username: msg.from?.username,
    first_name: firstName,
    is_active: true,
  });

  sessions.set(chatId, { step: "delivery_time", firstName });

  await bot.sendMessage(
    chatId,
    `👋 <b>Welcome to Goldirham Stack!</b>\n\n` +
      `I deliver daily AI infrastructure intelligence — chips, cloud, datacenters, power, and more — every morning.\n\n` +
      `Let's personalise your digest in <b>4 quick steps</b>. You can skip any step and change everything later with /settings.`,
    { parse_mode: "HTML" }
  );

  await sendTimeStep(bot, chatId, firstName);
}

/** Handle callback queries from onboarding inline keyboards. Returns true if handled. */
export async function handleOnboardingCallback(
  bot: TelegramBot,
  query: CallbackQuery
): Promise<boolean> {
  const data = query.data || "";
  const chatId = query.message?.chat.id;
  if (!chatId || !data.startsWith("ob_")) return false;

  const state = sessions.get(chatId);
  if (!state) {
    await bot.answerCallbackQuery(query.id, { text: "Session expired — send /start to begin again." });
    return true;
  }

  await bot.answerCallbackQuery(query.id);

  // ── Delivery time ─────────────────────────────────────────────────────────
  if (data.startsWith("ob_time_")) {
    const timeVal = data.replace("ob_time_", "");
    state.deliveryTime = timeVal === "skip" ? "08:00" : timeVal;
    state.step = "watchlist";

    // Edit the prompt message to show confirmation
    if (query.message?.message_id) {
      await bot.editMessageText(
        `⏰ <b>Step 1/4 — Delivery time</b>\n\n` +
          `✓ Set to <b>${state.deliveryTime} MYT</b>`,
        { chat_id: chatId, message_id: query.message.message_id, parse_mode: "HTML" }
      ).catch(() => {/* ignore edit failures */});
    }

    await sendWatchlistStep(bot, chatId);
    return true;
  }

  // ── Watchlist skip ────────────────────────────────────────────────────────
  if (data === "ob_watchlist_skip") {
    state.watchlist = [];
    state.step = "min_score";

    if (query.message?.message_id) {
      await bot.editMessageText(
        `📈 <b>Step 2/4 — Ticker watchlist</b>\n\n✓ Skipped — full digest`,
        { chat_id: chatId, message_id: query.message.message_id, parse_mode: "HTML" }
      ).catch(() => {});
    }

    await sendScoreStep(bot, chatId);
    return true;
  }

  // ── Min score ─────────────────────────────────────────────────────────────
  if (data.startsWith("ob_score_")) {
    const score = parseInt(data.replace("ob_score_", ""), 10);
    state.minScore = score;

    if (query.message?.message_id) {
      const label = score === 0 ? "All news" : score === 5 ? "Medium+ (5+)" : "High only (8+)";
      await bot.editMessageText(
        `🎯 <b>Step 3/4 — Impact filter</b>\n\n✓ <b>${label}</b>`,
        { chat_id: chatId, message_id: query.message.message_id, parse_mode: "HTML" }
      ).catch(() => {});
    }

    await sendLengthStep(bot, chatId);
    return true;
  }

  // ── Digest length ─────────────────────────────────────────────────────────
  if (data.startsWith("ob_len_")) {
    const length = data.replace("ob_len_", "") as "brief" | "standard" | "detailed";
    state.digestLength = length;
    state.step = "done";

    if (query.message?.message_id) {
      const label = length === "brief" ? "Brief" : length === "detailed" ? "Detailed" : "Standard";
      await bot.editMessageText(
        `📝 <b>Step 4/4 — Digest length</b>\n\n✓ <b>${label}</b>`,
        { chat_id: chatId, message_id: query.message.message_id, parse_mode: "HTML" }
      ).catch(() => {});
    }

    // Save all preferences to Supabase
    await saveOnboardingPrefs(chatId, state);
    await sendConfirmation(bot, chatId, state);
    sessions.delete(chatId);
    return true;
  }

  return false;
}

/** Handle free-text watchlist input during onboarding. Returns true if handled. */
export async function handleOnboardingText(
  bot: TelegramBot,
  msg: Message
): Promise<boolean> {
  const chatId = msg.chat.id;
  const state = sessions.get(chatId);
  if (!state || state.step !== "watchlist") return false;

  const raw = msg.text || "";
  const tickers = raw
    .toUpperCase()
    .split(/[,\s]+/)
    .map((t: string) => t.trim())
    .filter((t: string) => /^[A-Z]{1,5}$/.test(t));

  if (tickers.length === 0) {
    await bot.sendMessage(chatId,
      `⚠️ Couldn't parse those tickers. Try again like <code>NVDA, AMD</code> or tap Skip.`,
      { parse_mode: "HTML" }
    );
    return true;
  }

  state.watchlist = tickers;
  state.step = "min_score";

  await bot.sendMessage(chatId,
    `📈 Watchlist saved: <code>${tickers.join(", ")}</code>`,
    { parse_mode: "HTML" }
  );

  await sendScoreStep(bot, chatId);
  return true;
}

async function saveOnboardingPrefs(chatId: number, state: OnboardingState): Promise<void> {
  try {
    await supabase.upsertUserPreferences({
      chat_id: chatId,
      preferred_time: state.deliveryTime || "08:00",
      timezone: "Asia/Kuala_Lumpur",
      watchlist: state.watchlist || [],
      min_impact_score: state.minScore || 0,
      digest_length: state.digestLength || "standard",
      is_active: true,
    });
    logger.info(`Onboarding complete for ${chatId}: time=${state.deliveryTime}, tickers=${state.watchlist?.length || 0}, minScore=${state.minScore}, length=${state.digestLength}`);
  } catch (err) {
    logger.warn(`Onboarding save failed for ${chatId}: ${(err as Error).message}`);
  }
}
