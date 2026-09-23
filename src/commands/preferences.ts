import { config } from "../config";
import { createHash, randomInt } from "node:crypto";
import { sendEmailVerification } from "../sender/email";
import { registerCommand } from "../sender/telegram";
import { escapeHtml } from "../utils/escape";
import { todayInTimezone } from "../utils/helpers";
import { inferDirection } from "../utils/price-watch";
import type { PriceWatch } from "../utils/price-watch";
import { fetchStockPrices } from "../utils/stocks";
import { supabase } from "../utils/supabase";

export function registerPreferenceCommands(): void {
  registerCommand("personalization", async ctx => {
    const mode = ctx.text.trim().split(/\s+/)[1];
    if (mode !== "only" && mode !== "prioritize") return "Use /personalization prioritize or /personalization only. Only mode includes just your watched companies.";
    if (!supabase.isConfigured()) return "Preferences are temporarily unavailable.";
    const saved = await supabase.upsertUserPreferences({ chat_id: ctx.chatId, watchlist_mode: mode });
    return saved ? `Watchlist mode: ${mode}. This applies to scheduled briefings and /digest.` : "Could not save your preference. Please try again.";
  });
  registerCommand("delivery", async (ctx) => {
    if (!supabase.isConfigured()) {
      return "Supabase not configured. Personal delivery settings require a database.";
    }

    const parts = ctx.text.trim().split(/\s+/).slice(1);
    const channel = parts[0]?.toLowerCase();
    const value = parts.slice(1).join(" ").trim();

    if (!channel) {
      const prefs = await supabase.getUserPreferences(ctx.chatId);
      const email = prefs?.delivery_email ? maskEmail(prefs.delivery_email) : "Off";
      const slack = prefs?.slack_webhook_url ? "Configured" : "Off";
      return (
        `📬 <b>Delivery Copies</b>\n\n` +
        `Telegram: ✅ Primary\n` +
        `Email: ${escapeHtml(email)}\n` +
        `Slack: ${slack}\n\n` +
        `<b>Commands:</b>\n` +
        `• <code>/delivery email you@example.com</code>\n` +
        `• <code>/delivery email verify 123456</code>\n` +
        `• <code>/delivery email off</code>\n` +
        `• <code>/delivery slack WEBHOOK_URL</code>\n` +
        `• <code>/delivery slack off</code>\n\n` +
        `<i>Copies use the same filters and digest length as Telegram.</i>`
      );
    }

    if (channel === "email") {
      const verificationMatch = value.match(/^verify\s+(\d{6})$/i);
      if (verificationMatch) {
        const verified = await supabase.verifyDeliveryEmail(
          ctx.chatId,
          emailVerificationHash(ctx.chatId, verificationMatch[1])
        );
        return verified
          ? "Email destination verified. Daily copies are now enabled."
          : "That verification code is invalid or expired. Request a new code with <code>/delivery email you@example.com</code>.";
      }
      if (value.toLowerCase() === "off") {
        const ok = await supabase.upsertUserPreferences({ chat_id: ctx.chatId, delivery_email: null });
        return ok ? "Email copy disabled." : "Could not update email delivery.";
      }
      if (!isValidEmail(value)) {
        return "Enter a valid email address, or use <code>/delivery email off</code>.";
      }
      if (!config.app.smtpUser || !config.app.smtpPass) {
        return "Email verification is unavailable because SMTP is not configured on the server.";
      }

      const email = value.toLowerCase();
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      const created = await supabase.createEmailVerification(
        ctx.chatId,
        email,
        emailVerificationHash(ctx.chatId, code),
        expiresAt
      );
      if (!created) return "Could not start email verification. Wait at least 60 seconds before requesting another code; each destination is limited to five requests per hour.";

      const sent = await sendEmailVerification(email, code);
      return sent
        ? `A verification code was sent to <b>${escapeHtml(maskEmail(email))}</b>. Use <code>/delivery email verify 123456</code> within 15 minutes.`
        : "The verification email could not be delivered. Check the address and try again later.";
    }

    if (channel === "slack") {
      if (value.toLowerCase() === "off") {
        const ok = await supabase.upsertUserPreferences({ chat_id: ctx.chatId, slack_webhook_url: null });
        return ok ? "Slack copy disabled." : "Could not update Slack delivery.";
      }
      if (!isValidSlackWebhook(value)) {
        return "Use an HTTPS Incoming Webhook from <code>hooks.slack.com</code>, or <code>/delivery slack off</code>.";
      }
      const ok = await supabase.upsertUserPreferences({ chat_id: ctx.chatId, slack_webhook_url: value });
      return ok
        ? "Slack copies enabled. The webhook is stored privately and is never shown back in chat. You can delete your setup message now."
        : "Could not save the Slack webhook.";
    }

    return "Unknown channel. Use <code>/delivery</code> to see email and Slack options.";
  });

  registerCommand("alert", async (ctx) => {
    const parts = ctx.text.split(/\s+/).slice(1);
    const setting = parts[0]?.toLowerCase();

    if (setting === "on") {
      if (!supabase.isConfigured()) {
        return "Supabase not configured. Alert preferences require a database.";
      }
      const ok = await supabase.upsertUserPreferences({
        chat_id: ctx.chatId,
        alerts_enabled: true,
      });
      if (ok) {
        return "🚨 <b>Alerts Enabled</b>\n\nYou'll now receive instant notifications for high-impact articles (score 8+).\n\nUse <code>/alert threshold 9</code> to change the minimum score.\nUse <code>/alert off</code> to disable.";
      }
      return "Could not save alert preference.";
    }

    if (setting === "off") {
      if (!supabase.isConfigured()) {
        return "Supabase not configured.";
      }
      const ok = await supabase.upsertUserPreferences({
        chat_id: ctx.chatId,
        alerts_enabled: false,
      });
      return ok
        ? "🔕 Alerts disabled. You won't receive instant notifications."
        : "Could not save alert preference.";
    }

    if (setting === "threshold") {
      const val = parseInt(parts[1], 10);
      if (isNaN(val) || val < 1 || val > 10) {
        return "Threshold must be a number between 1 and 10.\n\nUsage: <code>/alert threshold 9</code>";
      }
      if (!supabase.isConfigured()) return "Supabase not configured.";
      const ok = await supabase.upsertUserPreferences({
        chat_id: ctx.chatId,
        alerts_min_score: val,
      });
      return ok
        ? `✅ Alert threshold set to <b>${val}/10</b>. Only articles scoring ${val}+ will trigger alerts.`
        : "Could not save threshold.";
    }

    // Show status
    if (!supabase.isConfigured()) {
      return "Supabase not configured. Alerts require a database.\n\n<b>Commands:</b>\n• <code>/alert on</code> — Enable high-impact alerts\n• <code>/alert off</code> — Disable alerts";
    }
    const prefs = await supabase.getUserPreferences(ctx.chatId);
    const status = prefs?.alerts_enabled ? "✅ Enabled" : "❌ Disabled";
    const threshold = prefs?.alerts_min_score ?? 8;
    return (
      `🚨 <b>Alert Settings</b>\n\n` +
      `Status: ${status}\n` +
      `Threshold: ${threshold}/10\n\n` +
      `<b>Commands:</b>\n` +
      `• <code>/alert on</code> — Enable alerts\n` +
      `• <code>/alert off</code> — Disable alerts\n` +
      `• <code>/alert threshold 9</code> — Set minimum impact score`
    );
  });

  registerCommand("watch", async (ctx) => {
    if (!supabase.isConfigured()) {
      return "Price watches are temporarily unavailable. Please try again later.";
    }

    const parts = ctx.text.split(/\s+/).slice(1);
    const first = parts[0]?.toUpperCase();

    const usage =
      `<b>Price Watch</b>\n\n` +
      `Checked at daily delivery using quotes no older than 15 minutes. This is a sampled threshold check, not a real-time crossing alert.\n\n` +
      `<b>Commands:</b>\n` +
      `• <code>/watch NVDA 130</code> — Notify when a daily sample meets the $130 threshold\n` +
      `• <code>/watch NVDA off</code> — Clear a watch\n` +
      `• <code>/watch list</code> — Show active watches`;

    if (!first || first === "LIST") {
      const watches = await supabase.queryRows<PriceWatch>(
        "price_watches",
        `chat_id=eq.${ctx.chatId}&select=*&order=created_at.desc`
      );
      if (!watches.length) return `No active price watches.\n\n${usage}`;
      const lines = ["🔔 <b>Active Price Watches</b>", ""];
      for (const w of watches) {
        const arrow = w.direction === "above" ? "≥" : "≤";
        lines.push(`<b>${escapeHtml(w.ticker)}</b> ${arrow} $${w.threshold}`);
      }
      return { text: lines.join("\n") };
    }

    const ticker = first;
    const second = parts[1]?.toLowerCase();

    if (second === "off") {
      const ok = await supabase.deletePriceWatch(ctx.chatId, ticker);
      return ok
        ? `🔕 Cleared the watch on <b>${escapeHtml(ticker)}</b>.`
        : `Could not clear the watch on ${escapeHtml(ticker)}.`;
    }

    if (!second) {
      return `Give me a price or "off".\n\n${usage}`;
    }

    const threshold = parseFloat(second);
    if (!Number.isFinite(threshold) || threshold <= 0) {
      return `Price must be a positive number.\n\n${usage}`;
    }

    const prices = await fetchStockPrices([ticker]);
    const currentPrice = prices.get(ticker)?.price;

    if (currentPrice === undefined || !Number.isFinite(currentPrice) || currentPrice <= 0) {
      return `Could not fetch a price for <b>${escapeHtml(ticker)}</b> — check the symbol and try again.`;
    }

    const direction = inferDirection(threshold, currentPrice);
    const ok = await supabase.upsertPriceWatch({
      chat_id: ctx.chatId,
      ticker,
      threshold,
      direction,
    });

    if (!ok) return "Could not save the watch.";

    const arrow = direction === "above" ? "rises to" : "drops to";
    return (
      `🔔 Watching <b>${escapeHtml(ticker)}</b> — you'll be notified once it ${arrow} $${threshold} ` +
      `(last available quote $${currentPrice.toFixed(2)}). Checked at daily delivery, not in real time.`
    );
  });

  registerCommand("feedback", async (ctx) => {
    const parts = ctx.text.split(/\s+/).slice(1);
    const ratingToken = parts[0] || "";
    const rating = Number(ratingToken);
    const comment = parts.slice(1).join(" ").trim();

    if (!/^[1-5]$/.test(ratingToken)) {
      return (
        `💬 <b>Feedback</b>\n\n` +
        `Help me improve! Rate today's digest from 1 to 5.\n\n` +
        `<b>Usage:</b>\n` +
        `• <code>/feedback 5</code> — Rate 1–5 (required)\n` +
        `• <code>/feedback 4 Great coverage of NVIDIA</code> — Add a comment\n` +
        `• <code>/feedback 2 Too many articles on power sector</code>\n\n` +
        `<i>Your feedback is kept private and helps improve the digest.</i>`
      );
    }

    if (comment.length > 2000) {
      return "Your comment is too long. Please keep it to 2,000 characters or fewer.";
    }

    if (!supabase.isConfigured()) {
      return `✅ Thanks for your ${rating}/5 rating! ${comment ? `Comment: "${escapeHtml(comment)}"` : ""}\n\nYour feedback helps improve the digest.`;
    }

    try {
      const today = todayInTimezone(config.app.timezone);
      const saved = await supabase.submitDigestFeedback(ctx.chatId, today, rating, comment || undefined);
      if (!saved) {
        return "Your feedback could not be saved. Please try again later.";
      }

      return `✅ Thanks for your feedback!\n\n` +
        `Your rating: ${rating}/5\n` +
        `Your feedback was recorded privately to improve the digest.`;
    } catch {
      return "Your feedback could not be saved. Please try again later.";
    }
  });
}

export function isValidEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@,;<>()[\]\r\n]+@[^\s@,;<>()[\]\r\n]+\.[^\s@,;<>()[\]\r\n]+$/.test(value);
}

export function isValidSlackWebhook(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "hooks.slack.com" || url.hostname === "hooks.slack-gov.com") &&
      url.pathname.startsWith("/services/");
  } catch {
    return false;
  }
}

export function emailVerificationHash(chatId: number, code: string): string {
  return createHash("sha256").update(`${chatId}:${code}`).digest("hex");
}

function maskEmail(value: string): string {
  const [local, domain] = value.split("@");
  if (!local || !domain) return "Configured";
  return `${local[0]}${local.length > 1 ? "***" : ""}@${domain}`;
}
