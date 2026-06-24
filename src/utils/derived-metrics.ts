/**
 * Materialized time-series intelligence layer.
 *
 * Computes per-day sector and ticker aggregates from a completed DigestResult
 * and persists them to `daily_derived_metrics` via an idempotent upsert.
 * Called at the end of generateDigest() so every pipeline run contributes to
 * the compounding historical dataset.
 *
 * Uses raw fetch (not the supabase wrapper) because supabaseFetch is not exported.
 */

import { config } from "../config";
import { logger } from "./logger";
import type { DigestResult } from "../processor/ai";
import type { StockPrice } from "./stocks";

interface DerivedMetricsRow {
  date: string;
  entity_type: "ticker" | "sector";
  entity: string;
  mention_count: number;
  avg_sentiment: number | null;
  avg_impact_score: number | null;
  bullish_count: number;
  bearish_count: number;
  price_close: number | null;
  price_change_pct: number | null;
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function buildRows(
  digest: DigestResult,
  runDate: string,
  stockPrices: Map<string, StockPrice>
): DerivedMetricsRow[] {
  const rows: DerivedMetricsRow[] = [];

  // ── Sector rows ──────────────────────────────────────────────────────────────
  const sectorMap = new Map<string, { impacts: number[]; bullish: number; bearish: number }>();
  for (const article of digest.articles) {
    const sector = article.category;
    if (!sectorMap.has(sector)) sectorMap.set(sector, { impacts: [], bullish: 0, bearish: 0 });
    const s = sectorMap.get(sector)!;
    s.impacts.push(article.impactScore);
    if (article.impact === "Bullish") s.bullish++;
    else if (article.impact === "Bearish") s.bearish++;
  }
  for (const [sector, data] of sectorMap) {
    rows.push({
      date: runDate,
      entity_type: "sector",
      entity: sector,
      mention_count: data.impacts.length,
      avg_sentiment: null,
      avg_impact_score: mean(data.impacts),
      bullish_count: data.bullish,
      bearish_count: data.bearish,
      price_close: null,
      price_change_pct: null,
    });
  }

  // ── Ticker rows ───────────────────────────────────────────────────────────────
  const tickerMap = new Map<string, { impacts: number[]; bullish: number; bearish: number }>();
  for (const article of digest.articles) {
    for (const ticker of article.affectedStocks) {
      if (!tickerMap.has(ticker)) tickerMap.set(ticker, { impacts: [], bullish: 0, bearish: 0 });
      const t = tickerMap.get(ticker)!;
      t.impacts.push(article.impactScore);
      if (article.impact === "Bullish") t.bullish++;
      else if (article.impact === "Bearish") t.bearish++;
    }
  }
  for (const [ticker, data] of tickerMap) {
    const price = stockPrices.get(ticker);
    rows.push({
      date: runDate,
      entity_type: "ticker",
      entity: ticker,
      mention_count: data.impacts.length,
      avg_sentiment: null,
      avg_impact_score: mean(data.impacts),
      bullish_count: data.bullish,
      bearish_count: data.bearish,
      price_close: price?.price ?? null,
      price_change_pct: price?.changePercent ?? null,
    });
  }

  return rows;
}

export async function writeDerivedMetrics(
  digest: DigestResult,
  runDate: string,
  stockPrices: Map<string, StockPrice>
): Promise<void> {
  const url = config.app.supabaseUrl;
  const key = config.app.supabaseServiceKey;
  if (!url || !key) return;

  const rows = buildRows(digest, runDate, stockPrices);
  if (!rows.length) return;

  try {
    const res = await fetch(
      `${url}/rest/v1/daily_derived_metrics?on_conflict=date,entity_type,entity`,
      {
        method: "POST",
        headers: {
          "apikey": key,
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json",
          "Prefer": "return=minimal,resolution=merge-duplicates",
        },
        body: JSON.stringify(rows),
      }
    );
    if (!res.ok) {
      logger.warn(`writeDerivedMetrics: HTTP ${res.status}`);
    } else {
      logger.info(`Derived metrics: wrote ${rows.length} rows for ${runDate}`);
    }
  } catch (err) {
    logger.warn(`writeDerivedMetrics: ${(err as Error).message}`);
  }
}

/**
 * Query the last N days of derived metrics for a specific entity.
 * Returns rows sorted oldest-first for sparkline rendering.
 */
export async function queryDerivedMetrics(
  entityType: "ticker" | "sector",
  entity: string,
  days: number
): Promise<DerivedMetricsRow[]> {
  const url = config.app.supabaseUrl;
  const key = config.app.supabaseServiceKey;
  if (!url || !key) return [];

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const sinceStr = since.toISOString().split("T")[0];

  try {
    const res = await fetch(
      `${url}/rest/v1/daily_derived_metrics` +
      `?entity_type=eq.${entityType}&entity=eq.${encodeURIComponent(entity)}` +
      `&date=gte.${sinceStr}&order=date.asc&limit=${days}`,
      {
        headers: {
          "apikey": key,
          "Authorization": `Bearer ${key}`,
        },
      }
    );
    if (!res.ok) return [];
    return (await res.json()) as DerivedMetricsRow[];
  } catch {
    return [];
  }
}

/**
 * Query the last 8 days across all entities to compute "What Changed" WoW deltas.
 * Returns all rows for the period, sorted oldest-first.
 */
export async function queryRecentDerivedMetrics(): Promise<DerivedMetricsRow[]> {
  const url = config.app.supabaseUrl;
  const key = config.app.supabaseServiceKey;
  if (!url || !key) return [];

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 8);
  const sinceStr = since.toISOString().split("T")[0];

  try {
    const res = await fetch(
      `${url}/rest/v1/daily_derived_metrics?date=gte.${sinceStr}&order=date.asc&limit=1000`,
      {
        headers: {
          "apikey": key,
          "Authorization": `Bearer ${key}`,
        },
      }
    );
    if (!res.ok) return [];
    return (await res.json()) as DerivedMetricsRow[];
  } catch {
    return [];
  }
}
