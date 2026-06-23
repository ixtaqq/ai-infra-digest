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
import { runPipeline } from "./index";
import { startInteractiveBot } from "./sender/telegram";

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
    // Invalid timezone — fall back to UTC
    return new Date().toISOString().slice(11, 16);
  }
}

/**
 * Check if a user's preferred_time matches the current time in their timezone.
 * Returns true if the times match within a configurable window (default: exact match).
 */
function isTimeMatch(
  preferredTime: string | undefined,
  userTimezone: string | undefined
): boolean {
  const pref = preferredTime || "08:00"; // Default fallback
  const tz = userTimezone || "Asia/Kuala_Lumpur"; // Default timezone
  const now = getCurrentTimeInTimezone(tz);
  return pref === now;
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

  // Run the full pipeline once (feeds + AI + formatting), then deliver per-user
  // To avoid hitting RSS feeds and AI multiple times, we run the pipeline once
  // and re-deliver the formatted result. But since runPipeline handles sending
  // inline, we need to run it per user.
  //
  // For efficiency: we collect articles once, process AI once, then format+send
  // per user based on their watchlist. But as a first implementation, run the
  // full pipeline for each user (this also respects per-user watchlist filtering).
  let successCount = 0;
  let failCount = 0;

  for (const user of pendingUsers) {
    logger.info(`Delivering digest to user ${user.first_name || user.chat_id} (chat: ${user.chat_id})`);

    try {
      // Run the pipeline targeting this specific user
      const success = await runPipeline(user.chat_id);
      if (success) {
        successCount++;
      } else {
        failCount++;
      }
    } catch (error) {
      failCount++;
      logger.error(`Delivery failed for user ${user.chat_id}: ${(error as Error).message}`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info(
    `✅ Scheduled delivery complete in ${elapsed}s — ` +
      `${successCount} delivered, ${failCount} failed` +
      ` (${pendingUsers.length} target users)`
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
