export interface FeedHealthRow {
  feed_name: string;
  status: string;
}

/**
 * Rows must be ordered newest first. Failures older than the newest success do
 * not belong to the current consecutive-failure streak.
 */
export function findConsistentlyFailingFeeds(
  rows: FeedHealthRow[],
  threshold: number
): Set<string> {
  const state = new Map<string, { failures: number; streakEnded: boolean }>();

  for (const row of rows) {
    const current = state.get(row.feed_name) || { failures: 0, streakEnded: false };
    if (!current.streakEnded) {
      if (row.status === "failed") current.failures++;
      else current.streakEnded = true;
    }
    state.set(row.feed_name, current);
  }

  return new Set(
    [...state.entries()]
      .filter(([, value]) => value.failures >= threshold)
      .map(([feedName]) => feedName)
  );
}
