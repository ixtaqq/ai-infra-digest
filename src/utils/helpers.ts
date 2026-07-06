/**
 * Shared utility helpers.
 */

/** Sleep for the given number of milliseconds. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse a non-negative float from an env-var string, falling back to `fallback`
 * on missing/malformed/negative input. Guards the budget caps against a typo
 * silently producing `NaN` (which would break every downstream `spend >= cap`
 * comparison) or a negative cap that would block every run.
 */
export function parsePositiveFloat(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

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
