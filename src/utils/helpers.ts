/**
 * Shared utility helpers.
 */

/** Sleep for the given number of milliseconds. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Today's calendar date (YYYY-MM-DD) in the given IANA timezone, not UTC.
 * `new Date().toISOString().split("T")[0]` silently uses UTC, which is the
 * wrong calendar day for part of the day whenever the timezone is ahead of
 * UTC (e.g. Asia/Kuala_Lumpur, UTC+8) — the run gets stamped with yesterday's
 * date and downstream day-keyed lookups (delivery idempotency, week-over-week
 * comparisons) silently compare against the wrong boundary.
 */
export function todayInTimezone(timezone: string, date: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().split("T")[0];
  }
}
