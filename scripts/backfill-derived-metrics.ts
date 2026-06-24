/**
 * Backfill historical data into daily_derived_metrics from existing
 * sector_activity and stock_mentions rows.
 *
 * Usage:
 *   npx tsx scripts/backfill-derived-metrics.ts --days=5
 *   npx tsx scripts/backfill-derived-metrics.ts --days=90
 *
 * Safe to re-run — upsert is idempotent via UNIQUE(date, entity_type, entity).
 */

import { config } from "../src/config.js";

const SUPABASE_URL = config.app.supabaseUrl;
const SUPABASE_KEY = config.app.supabaseServiceKey;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in config");
  process.exit(1);
}

const GET_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
};

const POST_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=minimal,resolution=merge-duplicates",
};

function getDateString(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

interface SectorActivityRow {
  date: string;
  sector: string;
  article_count: number;
  avg_impact_score: number | null;
  bullish_count: number;
  bearish_count: number;
}

interface StockMentionRow {
  date: string;
  ticker: string;
  mention_count: number;
  avg_sentiment: number | null;
  avg_impact_score: number | null;
  price: number | null;
  price_change_percent: number | null;
}

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

async function getSectorActivity(date: string): Promise<SectorActivityRow[]> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/sector_activity?date=eq.${date}&select=*`,
    { headers: GET_HEADERS }
  );
  if (!res.ok) return [];
  return (await res.json()) as SectorActivityRow[];
}

async function getStockMentions(date: string): Promise<StockMentionRow[]> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/stock_mentions?date=eq.${date}&select=*`,
    { headers: GET_HEADERS }
  );
  if (!res.ok) return [];
  return (await res.json()) as StockMentionRow[];
}

async function upsertDerivedMetrics(rows: DerivedMetricsRow[]): Promise<void> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/daily_derived_metrics?on_conflict=date,entity_type,entity`,
    {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify(rows),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
}

async function main() {
  const daysArg = process.argv.find((a) => a.startsWith("--days="));
  const days = daysArg ? parseInt(daysArg.split("=")[1], 10) : 30;

  console.log(`Backfilling ${days} days of derived metrics...`);
  let written = 0;
  let skipped = 0;

  for (let i = 0; i < days; i++) {
    const date = getDateString(i);

    const [sectors, tickers] = await Promise.all([
      getSectorActivity(date),
      getStockMentions(date),
    ]);

    if (!sectors.length && !tickers.length) {
      console.log(`  ${date}: no data — skipping`);
      skipped++;
      continue;
    }

    const rows: DerivedMetricsRow[] = [
      ...sectors.map((s) => ({
        date: s.date,
        entity_type: "sector" as const,
        entity: s.sector,
        mention_count: s.article_count,
        avg_sentiment: null,
        avg_impact_score: s.avg_impact_score,
        bullish_count: s.bullish_count,
        bearish_count: s.bearish_count,
        price_close: null,
        price_change_pct: null,
      })),
      ...tickers.map((t) => ({
        date: t.date,
        entity_type: "ticker" as const,
        entity: t.ticker,
        mention_count: t.mention_count,
        avg_sentiment: t.avg_sentiment,
        avg_impact_score: t.avg_impact_score,
        bullish_count: 0,
        bearish_count: 0,
        price_close: t.price,
        price_change_pct: t.price_change_percent,
      })),
    ];

    await upsertDerivedMetrics(rows);
    console.log(
      `  ${date}: ${sectors.length} sectors + ${tickers.length} tickers → ${rows.length} rows`
    );
    written += rows.length;

    // Brief pause to avoid hammering the API
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log(
    `\nDone. Written: ${written} rows, Skipped: ${skipped} dates with no data.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
