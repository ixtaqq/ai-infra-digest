#!/usr/bin/env tsx
/**
 * Scheduled Delivery Runner
 *
 * Designed to be called by a cron job (GitHub Actions scheduled workflow).
 * Queries all active users, finds those whose preferred_time matches the
 * current clock time in their timezone, and runs the digest pipeline for
 * each matching user — but only if they haven't already received a
 * successful delivery today (idempotency via user_delivery_log).
 *
 * Usage:
 *   npx tsx src/scheduler.ts
 *
 * GitHub Actions cron: every 15 minutes
 */

import { logger } from "./utils/logger";
import { supabase } from "./utils/supabase";
import { generateDigest, deliverDigest, persistDigestMetrics } from "./index";
import { startInteractiveBot, sendValidationFollowUp } from "./sender/telegram";

// ─── Time Helpers ───────────────────────────────────────

/**
 * Get the current time (HH:MM) in a given timezone.
 * Node 18+ supports the `timeZone` option for toLocaleTimeString.
 */
function getCurrentTimeInTimezone(tz: string): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return formatter.format(new Date());
  } catch {
    logger.warn(`Invalid timezone "${tz}" — falling back to UTC`);
    return new Date().toISOString().slice(11, 16);
  }
}

/**
 * Check if a user's preferred_time falls within ±2 minutes of now in their timezone.
 * A 2-minute window prevents missed deliveries when the cron tick lands slightly late.
 */
export function isTimeMatch(
  preferredTime: string | undefined,
  userTimezone: string | undefined,
  windowMinutes = 2
): boolean {
  const pref = preferredTime || "08:00";
  const tz = userTimezone || "Asia/Kuala_Lumpur";
  const now = getCurrentTimeInTimezone(tz);

  const toMinutes = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };

  const prefMins = toMinutes(pref);
  const nowMins = toMinutes(now);
  // Handle midnight wrap-around (e.g. 23:59 vs 00:01)
  const diff = Math.abs(prefMins - nowMins);
  const wrappedDiff = Math.min(diff, 1440 - diff);
  return wrappedDiff <= windowMinutes;
}

// ─── Main ────────────────────────────────────────────────

async function schedulerMain(): Promise<void> {
  const startTime = Date.now();
  const today = new Date().toISOString().split("T")[0];

  logger.info("⏰ Scheduled delivery check — starting");

  if (!supabase.isConfigured()) {
    logger.warn("Supabase not configured — scheduled delivery requires a database");
    return;
  }

  // Get all active users
  const users = await supabase.getAllActiveUsers();
  if (users.length === 0) {
    logger.info("No active users found — nothing to deliver");
    return;
  }

  logger.info(`Found ${users.length} active users — checking time preferences`);

  // Find users whose preferred time matches now
  const matchingUsers = users.filter((u) => isTimeMatch(u.preferred_time, u.timezone));

  if (matchingUsers.length === 0) {
    logger.info(`No users at their preferred delivery time right now`);
    return;
  }

  logger.info(
    `${matchingUsers.length} user(s) at preferred delivery time: ` +
      matchingUsers.map((u) => `${u.first_name || u.chat_id} (${u.preferred_time || "08:00"} ${u.timezone || "MYT"})`).join(", ")
  );

  // Check idempotency — skip users already delivered today
  const toDeliver = await Promise.all(
    matchingUsers.map(async (user) => {
      const alreadyDelivered = await supabase.wasUserDeliveredToday(user.chat_id, today);
      if (alreadyDelivered) {
        logger.info(`Skipping user ${user.chat_id} — already delivered today`);
        return null;
      }
      return user;
    })
  );

  const pendingUsers = toDeliver.filter((u): u is NonNullable<typeof u> => u !== null);

  if (pendingUsers.length === 0) {
    logger.info("All matching users already received today's digest — nothing to do");
    return;
  }

  logger.info(`Delivering digest to ${pendingUsers.length} user(s)`);

  // Generate the digest ONCE, then fan out the same formatted message to every
  // matching user. This is the whole point of the scheduler: the expensive work
  // (RSS crawl + AI + SEC + earnings + stock prices) happens a single time per
  // run regardless of how many users are due, instead of once per user.
  const generated = await generateDigest();
  if (!generated) {
    logger.error("Digest generation failed — no deliveries performed this run");
    return;
  }

  let successCount = 0;
  let failCount = 0;
  const successfulChatIds: number[] = [];

  for (const user of pendingUsers) {
    try {
      const result = await deliverDigest(generated, user.chat_id, user);
      if (result.success) {
        successCount++;
        successfulChatIds.push(user.chat_id);
      } else {
        failCount++;
      }
    } catch (error) {
      failCount++;
      logger.error(`Delivery failed for user ${user.chat_id}: ${(error as Error).message}`);
    }
  }

  // Record run metrics once for this single generation — not once per user.
  const articleIds = await persistDigestMetrics(
    generated,
    successCount > 0 ? "success" : "failed",
    failCount > 0 ? `${failCount} of ${pendingUsers.length} user deliveries failed` : undefined
  );

  // Send validation follow-up to all users who received the digest successfully
  if (articleIds.size > 0 && successfulChatIds.length > 0) {
    for (const chatId of successfulChatIds) {
      try {
        await sendValidationFollowUp(chatId, generated.digest.articles, articleIds);
      } catch {
        // Non-critical
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info(
    `✅ Scheduled delivery complete in ${elapsed}s — ` +
      `${successCount} delivered, ${failCount} failed ` +
      `(${pendingUsers.length} users, 1 generation)`
  );
}

// ─── Run ─────────────────────────────────────────────────

// Start interactive bot so command handlers are available
startInteractiveBot();

schedulerMain()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ Scheduler failed:", error);
    process.exit(1);
  });
