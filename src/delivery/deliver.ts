import { config } from "../config";
import { formatDigestTelegram } from "../formatter/telegram";
import { sendEmailDigest } from "../sender/email";
import { sendSlackDigest } from "../sender/slack";
import { sendDigestMessage, sendDigestMessageToUser } from "../sender/telegram";
import type { SendResult } from "../sender/telegram";
import type { GeneratedDigest } from "../pipeline/types";
import { escapeHtml } from "../utils/escape";
import { logger } from "../utils/logger";
import { emitDigestDelivery, emitError } from "../utils/metrics";
import { isTriggered } from "../utils/price-watch";
import { supabase } from "../utils/supabase";
import type { UserPreferencesData } from "../utils/supabase";
import { todayInTimezone } from "../utils/helpers";
import { personalizeDigest } from "./personalization";

function deliveryLatenessSeconds(
  preferredTime = "08:00",
  timezone = "Asia/Kuala_Lumpur",
  now = new Date()
): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
    const minute = Number(parts.find((part) => part.type === "minute")?.value || 0);
    const [preferredHour = 8, preferredMinute = 0] = preferredTime.split(":").map(Number);
    return Math.max(0, (hour * 60 + minute - preferredHour * 60 - preferredMinute) * 60);
  } catch (error) {
    logger.warn(
      `Could not calculate delivery lateness for timezone "${timezone}": ${(error as Error).message}`
    );
    return 0;
  }
}

export async function deliverDigest(
  generated: GeneratedDigest,
  targetChatId?: number,
  userPrefs?: UserPreferencesData,
  deliveryDate?: string
): Promise<SendResult> {
  const { digest, stockPrices, startTime, secExtracts, earningsAnalyses } = generated;
  const runDate = targetChatId
    ? deliveryDate || todayInTimezone(userPrefs?.timezone || "Asia/Kuala_Lumpur")
    : generated.runDate;
  const personalization = userPrefs ? personalizeDigest(digest, userPrefs) : undefined;
  const isPersonalized = personalization?.applied ?? false;
  const messageToSend = isPersonalized
    ? formatDigestTelegram(personalization!.digest, {
        stockPrices,
        secExtracts: secExtracts.length > 0 ? secExtracts : undefined,
        earningsAnalyses: earningsAnalyses.length > 0 ? earningsAnalyses : undefined,
        personalizationNote: personalization!.note,
        whatChanged: generated.whatChanged,
        digestLength: personalization!.length,
      })
    : generated.formattedMessage;

  logger.info(
    targetChatId
      ? `Delivering digest to user ${targetChatId}${isPersonalized ? " (personalized)" : ""}...`
      : "Sending digest to default chat..."
  );

  let sendResult: SendResult;
  if (targetChatId) {
    const claimed = supabase.isConfigured()
      ? await supabase.claimUserDelivery(targetChatId, runDate)
      : true;
    if (!claimed) {
      logger.info(`Skipping delivery to user ${targetChatId} — already claimed for ${runDate} (concurrent run)`);
      return { success: false, error: "already delivered for this run date" };
    }

    try {
      sendResult = await sendDigestMessageToUser(targetChatId, messageToSend);
    } catch (error) {
      sendResult = { success: false, error: (error as Error).message };
    }

    const copyResults: string[] = [];
    if (sendResult.success) {
      const [slackResult, emailResult] = await Promise.allSettled([
        userPrefs?.slack_webhook_url
          ? sendSlackDigest(messageToSend, userPrefs.slack_webhook_url)
          : Promise.resolve(false),
        userPrefs?.delivery_email
          ? sendEmailDigest(messageToSend, userPrefs.delivery_email)
          : Promise.resolve(false),
      ]);
      if (userPrefs?.slack_webhook_url) {
        copyResults.push(
          `slack:${slackResult.status === "fulfilled" && slackResult.value ? "success" : "failed"}`
        );
      }
      if (userPrefs?.delivery_email) {
        copyResults.push(
          `email:${emailResult.status === "fulfilled" && emailResult.value ? "success" : "failed"}`
        );
      }
    }

    if (supabase.isConfigured()) {
      const details = [sendResult.error, ...copyResults].filter(Boolean).join("; ") || undefined;
      await supabase.logUserDelivery(
        targetChatId,
        runDate,
        sendResult.success ? "success" : "failed",
        details
      );
      await supabase.recordProductEvent(
        sendResult.success ? "delivery_succeeded" : "delivery_failed",
        targetChatId,
        {
          run_date: runDate,
          preferred_time: userPrefs?.preferred_time || "08:00",
          timezone: userPrefs?.timezone || "Asia/Kuala_Lumpur",
          lateness_seconds: deliveryLatenessSeconds(
            userPrefs?.preferred_time,
            userPrefs?.timezone
          ),
        }
      );
    }
  } else {
    sendResult = await sendDigestMessage(messageToSend);
  }

  if (targetChatId) {
    const triggered = generated.activeWatches
      .filter((watch) => watch.chat_id === targetChatId)
      .filter((watch) => {
        const price = stockPrices.get(watch.ticker)?.price;
        return price !== undefined && isTriggered(watch, price);
      });

    if (triggered.length > 0) {
      const lines = ["🔔 <b>Price Watch</b>", ""];
      for (const watch of triggered) {
        const price = stockPrices.get(watch.ticker)!.price;
        const direction = watch.direction === "above" ? "crossed above" : "dropped below";
        lines.push(
          `<b>${escapeHtml(watch.ticker)}</b> ${direction} $${watch.threshold} (now $${price.toFixed(2)})`
        );
      }
      const watchResult = await sendDigestMessageToUser(targetChatId, lines.join("\n"));
      if (watchResult.success && supabase.isConfigured()) {
        await supabase.deletePriceWatchesByIds(triggered.map((watch) => watch.id));
      }
    }
  }

  if (!targetChatId) {
    logger.info(
      `Additional channels — Slack: ${config.app.slackWebhookUrl ? "configured" : "not set"}, ` +
      `Email: ${config.app.smtpUser ? "configured" : "not set"}`
    );
    const [slackResult, emailResult] = await Promise.allSettled([
      config.app.slackWebhookUrl ? sendSlackDigest(messageToSend) : Promise.resolve(false),
      config.app.smtpUser && config.app.digestEmailTo
        ? sendEmailDigest(messageToSend)
        : Promise.resolve(false),
    ]);
    if (config.app.slackWebhookUrl && (slackResult.status === "rejected" || !slackResult.value)) {
      generated.capabilities.slack = { state: "degraded", detail: "delivery failed" };
    }
    if (
      config.app.smtpUser &&
      config.app.digestEmailTo &&
      (emailResult.status === "rejected" || !emailResult.value)
    ) {
      generated.capabilities.email = { state: "degraded", detail: "delivery failed" };
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  emitDigestDelivery(
    sendResult.success ? "success" : "failed",
    digest.articles.length,
    stockPrices.size,
    parseFloat(elapsed),
    digest.usage.totalTokens,
    sendResult.error
  );
  if (sendResult.success) {
    logger.info(
      `✅ Digest delivered in ${elapsed}s — ` +
      `${digest.articles.length} articles, ${stockPrices.size} prices, ${digest.topStocks.length} stocks`
    );
  } else {
    emitError("telegram", "error", `Digest delivery failed: ${sendResult.error}`);
    logger.error("Failed to deliver digest", { error: sendResult.error });
  }
  return sendResult;
}
