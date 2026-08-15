#!/usr/bin/env tsx
/**
 * Scheduled Delivery Runner
 *
 * Designed to be called by a cron job (GitHub Actions scheduled workflow).
 * Queries all active users, finds those whose preferred_time is due in their
 * timezone, and runs the digest pipeline for each user who has not already
 * received a successful delivery for that local date.
 *
 * Usage:
 *   npx tsx src/scheduler.ts
 *
 * GitHub Actions cron: every 10 minutes
 */

import { logger } from "./utils/logger";
import { supabase } from "./utils/supabase";
import { generateDigest, deliverDigest, persistDigestMetrics } from "./index";
import { sendValidationFollowUp } from "./sender/telegram";
import { todayInTimezone } from "./utils/helpers";
import { flushMetrics } from "./utils/metrics";

// ─── Time Helpers ───────────────────────────────────────

/** Get the current local clock minutes in a given timezone. */
function getCurrentMinutesInTimezone(tz: string, date: Date): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
    const minute = Number(parts.find((part) => part.type === "minute")?.value || 0);
    return hour * 60 + minute;
  } catch {
    logger.warn(`Invalid timezone "${tz}" — falling back to UTC`);
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }
}

/**
 * Check whether a user's scheduled delivery is due in their local timezone.
 * Once the preferred time has passed, the delivery stays due until the
 * per-user local date has a successful delivery record.
 */
export function isDeliveryDue(
  preferredTime: string | undefined,
  userTimezone: string | undefined,
  now: Date = new Date()
): boolean {
  const pref = preferredTime || "08:00";
  const tz = userTimezone || "Asia/Kuala_Lumpur";

  const toMinutes = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };

  const prefMins = toMinutes(pref);
  const nowMins = getCurrentMinutesInTimezone(tz, now);
  return nowMins >= prefMins;
}

/** Return the date key used for a user's delivery slot in their timezone. */
export function getDeliveryDate(
  userTimezone: string | undefined,
  now: Date = new Date()
): string {
  return todayInTimezone(userTimezone || "Asia/Kuala_Lumpur", now);
}

// ─── Main ────────────────────────────────────────────────

export async function schedulerMain(): Promise<void> {
  const startTime = Date.now();
  const now = new Date(startTime);

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

  // Find users whose preferred time has passed in their local timezone. The
  // successful-delivery check below makes this due state idempotent across all
  // later cron ticks on the same local date.
  const dueUsers = users.filter((u) => isDeliveryDue(u.preferred_time, u.timezone, now));

  if (dueUsers.length === 0) {
    logger.info(`No users are due for delivery right now`);
    return;
  }

  logger.info(
    `${dueUsers.length} user(s) due for delivery: ` +
      dueUsers.map((u) => `${u.first_name || u.chat_id} (${u.preferred_time || "08:00"} ${u.timezone || "MYT"})`).join(", ")
  );

  // Cheap read-only pre-filter to avoid running the full digest pipeline when
  // nobody is actually pending. This is an optimization, not the correctness
  // guarantee — deliverDigest() atomically claims each (chat_id, local date) slot
  // right before sending, which is what actually prevents double delivery from
  // overlapping scheduler runs.
  const toDeliver = await Promise.all(
    dueUsers.map(async (user) => {
      const deliveryDate = getDeliveryDate(user.timezone, now);
      const alreadyDelivered = await supabase.wasUserDeliveredToday(user.chat_id, deliveryDate);
      if (alreadyDelivered) {
        logger.info(`Skipping user ${user.chat_id} — already delivered for ${deliveryDate}`);
        return null;
      }
      return { user, deliveryDate };
    })
  );

  const pendingUsers = toDeliver.filter(
    (entry): entry is { user: (typeof users)[number]; deliveryDate: string } => entry !== null
  );

  if (pendingUsers.length === 0) {
    logger.info("All due users already received their local-date digest — nothing to do");
    return;
  }

  logger.info(`Delivering digest to ${pendingUsers.length} user(s)`);

  // Generate the digest ONCE, then fan out the same formatted message to every
  // due user. This is the whole point of the scheduler: the expensive work
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

  for (const { user, deliveryDate } of pendingUsers) {
    try {
      const result = await deliverDigest(generated, user.chat_id, user, deliveryDate);
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

if (require.main === module) {
  schedulerMain()
    .then(async () => {
      await flushMetrics();
      process.exit(0);
    })
    .catch(async (error) => {
      logger.error(`Scheduler failed: ${(error as Error).message}`, { stack: (error as Error).stack });
      await flushMetrics();
      process.exit(1);
    });
}
