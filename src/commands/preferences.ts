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
      if (!created) return "Could not start email verification. Please try again later.";

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
      return "Supabase not configured. Price watches require a database.";
    }

    const parts = ctx.text.split(/\s+/).slice(1);
    const first = parts[0]?.toUpperCase();

    const usage =
      `<b>Price Watch</b>\n\n` +
      `<b>Commands:</b>\n` +
      `• <code>/watch NVDA 130</code> — Notify once NVDA crosses $130\n` +
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
    if (isNaN(threshold) || threshold <= 0) {
      return `Price must be a positive number.\n\n${usage}`;
    }

    // Synchronous price lookup to infer direction — timeboxed so a slow/hanging
    // Yahoo Finance response can't hang this interactive command indefinitely.
    // Does not touch fetchStockPrices()'s shared batch-path behavior.
    const TIMEOUT_MS = 8000;
    const timeout = new Promise<Map<string, import("../utils/stocks").StockPrice>>((resolve) =>
      setTimeout(() => resolve(new Map()), TIMEOUT_MS)
    );
    const prices = await Promise.race([fetchStockPrices([ticker]), timeout]);
    const currentPrice = prices.get(ticker)?.price;

    if (currentPrice === undefined) {
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
      `(currently $${currentPrice.toFixed(2)}).`
    );
  });

  registerCommand("feedback", async (ctx) => {
    const parts = ctx.text.split(/\s+/).slice(1);
    const rating = parseInt(parts[0], 10);
    const comment = parts.slice(1).join(" ");

    if (isNaN(rating) || rating < 1 || rating > 5) {
      return (
        `💬 <b>Feedback</b>\n\n` +
        `Help me improve! Rate today's digest from 1 to 5.\n\n` +
        `<b>Usage:</b>\n` +
        `• <code>/feedback 5</code> — Rate 1–5 (required)\n` +
        `• <code>/feedback 4 Great coverage of NVIDIA</code> — Add a comment\n` +
        `• <code>/feedback 2 Too many articles on power sector</code>\n\n` +
        `<i>Your feedback is anonymous and helps improve the digest.</i>`
      );
    }

    if (!supabase.isConfigured()) {
      return `✅ Thanks for your ${rating}/5 rating! ${comment ? `Comment: "${escapeHtml(comment)}"` : ""}\n\nYour feedback helps improve the digest.`;
    }

    try {
      const today = todayInTimezone(config.app.timezone);
      const existing = await supabase.queryRows<Record<string, unknown>>(
        "daily_metrics",
        `date=eq.${encodeURIComponent(today)}&select=date,feedback_ratings`
      );

      let existingRatings: number[] = [];
      let existingComments: string[] = [];
      if (existing.length > 0 && existing[0].feedback_ratings) {
        try {
          const parsed = JSON.parse(existing[0].feedback_ratings as string) as { ratings: number[]; comments: string[] };
          existingRatings = parsed.ratings || [];
          existingComments = parsed.comments || [];
        } catch { /* start fresh */ }
      }

      existingRatings.push(rating);
      if (comment) existingComments.push(comment);

      await supabase.updateDailyMetrics(today, {
        feedback_ratings: JSON.stringify({ ratings: existingRatings, comments: existingComments }),
      });

      const avg = existingRatings.reduce((s, r) => s + r, 0) / existingRatings.length;
      return `✅ Thanks for your feedback!\n\n` +
        `Your rating: ${rating}/5\n` +
        `${comment ? `Comment: "${escapeHtml(comment)}"\n` : ""}\n` +
        `Average rating today: ${avg.toFixed(1)}/5 (${existingRatings.length} votes)`;
    } catch {
      return `✅ Thanks for your ${rating}/5 rating! (Couldn't save to database, but your feedback is noted.)`;
    }
  });
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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
