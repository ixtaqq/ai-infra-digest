/**
 * Trust-weighted multipliers derived from article_validations votes.
 *
 * Computes per-source and per-sector approval rates from the last 30 days
 * of 👍/👎 votes and maps them to [0.7, 1.3] multipliers used to re-rank
 * articles in generateDigest(). Neutral (1.0) when vote count < 3.
 *
 * Uses a 1-hour TTL in-process cache to avoid hammering Supabase on
 * every pipeline run. Safe to call concurrently — worst case: two fetches
 * race, last write wins, both results are equivalent.
 */

import { config } from "../config";
import { logger } from "./logger";
import { sendAdminAlert } from "../sender/telegram";

interface ValidationRow {
  rating: "up" | "down";
  articles: { source: string; category: string } | null;
}

interface VoteTally {
  up: number;
  down: number;
}

const cache = new Map<string, { data: Map<string, number>; expires: number }>();
const CACHE_TTL_MS = 3_600_000; // 1 hour
const MAX_CACHE_ENTRIES = 2;

function pruneCache(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expires <= now) cache.delete(key);
  }

  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

function approvalToMultiplier(up: number, down: number): number {
  const total = up + down;
  if (total < 3) return 1.0;
  const rate = up / total;
  return 0.7 + rate * 0.6; // [0.7, 1.3]
}

async function fetchRawValidations(): Promise<ValidationRow[]> {
  const url = config.app.supabaseUrl;
  const key = config.app.supabaseServiceKey;
  if (!url || !key) return [];

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 30);
  const sinceStr = since.toISOString().split("T")[0];

  try {
    const res = await fetch(
      `${url}/rest/v1/article_validations` +
        `?select=rating,articles(source,category)` +
        `&created_at=gte.${sinceStr}`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
      }
    );
    if (!res.ok) {
      logger.warn(`trust-scores: fetch HTTP ${res.status}`);
      return [];
    }
    return (await res.json()) as ValidationRow[];
  } catch (err) {
    logger.warn(`trust-scores: fetch error — ${(err as Error).message}`);
    return [];
  }
}

function computeMultipliers(
  rows: ValidationRow[],
  key: (row: ValidationRow) => string | null
): Map<string, number> {
  const tallies = new Map<string, VoteTally>();
  for (const row of rows) {
    const k = key(row);
    if (!k) continue;
    const t = tallies.get(k) ?? { up: 0, down: 0 };
    if (row.rating === "up") t.up++;
    else t.down++;
    tallies.set(k, t);
  }

  const result = new Map<string, number>();
  for (const [k, { up, down }] of tallies) {
    result.set(k, approvalToMultiplier(up, down));
  }
  return result;
}

async function fetchMultipliers(type: "source" | "sector"): Promise<Map<string, number>> {
  const rows = await fetchRawValidations();
  const multipliers = computeMultipliers(rows, (row) =>
    type === "source" ? (row.articles?.source ?? null) : (row.articles?.category ?? null)
  );

  // Hallucination detection: alert when a source has ≥3 votes and approvalRate < 0.25
  if (type === "source") {
    const tallies = new Map<string, VoteTally>();
    for (const row of rows) {
      const src = row.articles?.source;
      if (!src) continue;
      const t = tallies.get(src) ?? { up: 0, down: 0 };
      if (row.rating === "up") t.up++;
      else t.down++;
      tallies.set(src, t);
    }
    for (const [src, { up, down }] of tallies) {
      const total = up + down;
      if (total >= 3 && up / total < 0.25) {
        const pct = Math.round((up / total) * 100);
        sendAdminAlert(
          `⚠️ <b>Possible Hallucination Detected</b>\n\n` +
            `Source: <b>${src}</b>\n` +
            `Approval rate: ${pct}% (${up} 👍 / ${down} 👎 over 30 days)\n\n` +
            `Consider removing this source from the RSS feed list.`
        ).catch(() => {});
      }
    }
  }

  return multipliers;
}

async function getCachedMultipliers(type: "source" | "sector"): Promise<Map<string, number>> {
  const k = `${type}_trust`;
  const now = Date.now();
  pruneCache(now);
  const hit = cache.get(k);
  if (hit && hit.expires > now) return hit.data;
  const fresh = await fetchMultipliers(type);
  cache.set(k, { data: fresh, expires: now + CACHE_TTL_MS });
  pruneCache(Date.now());
  return fresh;
}

export async function getSourceMultipliers(): Promise<Map<string, number>> {
  return getCachedMultipliers("source");
}

export async function getSectorMultipliers(): Promise<Map<string, number>> {
  return getCachedMultipliers("sector");
}

export async function getTrustScores(): Promise<{
  source: Map<string, number>;
  sector: Map<string, number>;
}> {
  const [source, sector] = await Promise.all([
    getCachedMultipliers("source"),
    getCachedMultipliers("sector"),
  ]);
  return { source, sector };
}
