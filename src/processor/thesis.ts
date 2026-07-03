/**
 * Bull/Bear Thesis Snapshots (v10) — per-ticker AI investment narrative,
 * refreshed weekly from accumulated pipeline data.
 *
 * Data in: last 30d of daily_derived_metrics (mentions, impact, sentiment,
 * price trail) + the latest sec_filings extract per ticker.
 * Data out: one row per ticker upserted into ticker_theses.
 *
 * Cost: a single batched strong-model call for the top N tickers (~$0.01/week).
 * Rows are matched back by 1-based index — the same pattern as bear-cases.ts,
 * which exists because models don't reliably echo long strings back verbatim.
 */

import { z } from "zod";
import { config } from "../config";
import { logger } from "../utils/logger";
import { supabase } from "../utils/supabase";
import { withRetry, HttpError, isRetryableStatus } from "../utils/retry";

const TOP_TICKERS = 10;
const LOOKBACK_DAYS = 30;

export interface TickerSnapshot {
  ticker: string;
  totalMentions: number;
  avgImpactScore: number;
  bullishCount: number;
  bearishCount: number;
  latestPrice: number | null;
  priceChange30dPct: number | null;
  latestFiling?: string;
}

export interface ThesisRow {
  ticker: string;
  bull_case: string;
  bear_case: string;
  confidence: number;
  key_drivers: string[];
}

interface ThesisAIRow {
  index: number;
  bullCase?: string;
  bearCase?: string;
  confidence: number;
  keyDrivers?: string[];
}

// index/confidence are coerced (models occasionally return them as strings);
// bullCase/bearCase are genuinely optional here — the caller drops rows missing them.
const ThesisAIRowSchema = z.object({
  index: z.coerce.number(),
  bullCase: z.string().optional().catch(undefined),
  bearCase: z.string().optional().catch(undefined),
  confidence: z.coerce.number().catch(5),
  keyDrivers: z.array(z.string()).optional().catch(undefined),
});

const ResultsResponseSchema = z.object({
  results: z.array(z.unknown()).catch([]),
});

/** Aggregate 30d of derived metrics into per-ticker snapshots, top N by mentions. */
export async function collectTickerSnapshots(): Promise<TickerSnapshot[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().split("T")[0];
  const rows = await supabase.queryRows<{
    date: string;
    entity: string;
    mention_count: number;
    avg_impact_score: number | null;
    bullish_count: number;
    bearish_count: number;
    price_close: number | null;
  }>(
    "daily_derived_metrics",
    `entity_type=eq.ticker&date=gte.${encodeURIComponent(since)}&select=date,entity,mention_count,avg_impact_score,bullish_count,bearish_count,price_close&order=date.asc`
  );
  if (!rows.length) return [];

  const byTicker = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byTicker.get(row.entity) || [];
    list.push(row);
    byTicker.set(row.entity, list);
  }

  const snapshots: TickerSnapshot[] = [];
  for (const [ticker, history] of byTicker) {
    const totalMentions = history.reduce((s, r) => s + (r.mention_count || 0), 0);
    const impacts = history.map((r) => r.avg_impact_score).filter((v): v is number => v != null);
    const prices = history.map((r) => r.price_close).filter((v): v is number => v != null);
    const firstPrice = prices[0];
    const lastPrice = prices[prices.length - 1];
    snapshots.push({
      ticker,
      totalMentions,
      avgImpactScore: impacts.length ? Math.round((impacts.reduce((s, v) => s + v, 0) / impacts.length) * 10) / 10 : 0,
      bullishCount: history.reduce((s, r) => s + (r.bullish_count || 0), 0),
      bearishCount: history.reduce((s, r) => s + (r.bearish_count || 0), 0),
      latestPrice: lastPrice ?? null,
      priceChange30dPct:
        firstPrice && lastPrice ? Math.round(((lastPrice - firstPrice) / firstPrice) * 1000) / 10 : null,
    });
  }

  snapshots.sort((a, b) => b.totalMentions - a.totalMentions);
  const top = snapshots.slice(0, TOP_TICKERS);

  // Attach the latest SEC filing summary per ticker (one query, filtered client-side)
  const tickers = top.map((s) => s.ticker);
  const filings = await supabase.queryRows<{ ticker: string; form_type: string; filing_date: string; impact_rationale: string | null }>(
    "sec_filings",
    `ticker=in.(${tickers.map((t) => encodeURIComponent(t)).join(",")})&select=ticker,form_type,filing_date,impact_rationale&order=filing_date.desc&limit=50`
  );
  for (const snap of top) {
    const filing = filings.find((f) => f.ticker === snap.ticker);
    if (filing) {
      snap.latestFiling = `${filing.form_type} (${filing.filing_date})${filing.impact_rationale ? `: ${filing.impact_rationale.slice(0, 150)}` : ""}`;
    }
  }

  return top;
}

function buildPrompt(snapshots: TickerSnapshot[]): string {
  const items = snapshots
    .map((s, i) => {
      const lines = [
        `${i + 1}. ${s.ticker}`,
        `   30d mentions: ${s.totalMentions} (${s.bullishCount} bullish / ${s.bearishCount} bearish articles)`,
        `   Avg impact score: ${s.avgImpactScore}/10`,
      ];
      if (s.latestPrice != null) lines.push(`   Price: $${s.latestPrice}${s.priceChange30dPct != null ? ` (${s.priceChange30dPct >= 0 ? "+" : ""}${s.priceChange30dPct}% 30d)` : ""}`);
      if (s.latestFiling) lines.push(`   Latest SEC filing: ${s.latestFiling}`);
      return lines.join("\n");
    })
    .join("\n\n");

  return (
    `You are an institutional equity research analyst covering AI infrastructure. ` +
    `For each ticker below, write a concise investment thesis snapshot based ONLY on the provided 30-day data:\n` +
    `- bullCase: 2-3 sentence bull thesis\n` +
    `- bearCase: 2-3 sentence bear thesis\n` +
    `- confidence: 1-10 (how well the data supports a directional view; sparse/mixed data = low)\n` +
    `- keyDrivers: 2-4 short phrases naming the main drivers\n\n` +
    `Return valid JSON only, one entry per ticker, using its numeric index (1-${snapshots.length}) — do NOT repeat the ticker symbol:\n` +
    `{ "results": [ { "index": 1, "bullCase": "...", "bearCase": "...", "confidence": 7, "keyDrivers": ["...", "..."] } ] }\n\n` +
    `Tickers:\n${items}`
  );
}

// Exported for unit tests
export function parseThesisResponse(text: string): ThesisAIRow[] {
  const clean = text.replace(/^```[a-z]*\n?/m, "").replace(/```$/m, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(clean);
  } catch (err) {
    logger.warn(`thesis: failed to parse AI response (${(err as Error).message}). Raw (first 300 chars): ${clean.slice(0, 300)}`);
    return [];
  }

  const outer = ResultsResponseSchema.safeParse(parsed);
  if (!outer.success || outer.data.results.length === 0) {
    logger.warn(`thesis: parsed JSON had no "results" array. Raw (first 300 chars): ${clean.slice(0, 300)}`);
    return [];
  }

  const rows: ThesisAIRow[] = [];
  for (const raw of outer.data.results) {
    const row = ThesisAIRowSchema.safeParse(raw);
    if (row.success) rows.push(row.data);
  }
  return rows;
}

/** Generate theses for the top tickers and upsert them into ticker_theses. */
export async function generateTheses(): Promise<ThesisRow[]> {
  const snapshots = await collectTickerSnapshots();
  if (!snapshots.length) {
    logger.info("Thesis: no derived-metrics history yet — nothing to generate");
    return [];
  }

  const url = config.ai.baseUrl || "https://api.groq.com/openai/v1";
  const key = config.ai.apiKey;
  if (!key) return [];

  const prompt = buildPrompt(snapshots);

  const data = await withRetry(
    async () => {
      const res = await fetch(`${url}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: config.ai.model,
          messages: [
            { role: "system", content: "You are an equity research AI. Always respond with valid JSON only." },
            { role: "user", content: prompt },
          ],
          temperature: 0.4,
          max_tokens: 3000,
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new HttpError(res.status, `AI HTTP ${res.status}`);
      return (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    },
    {
      label: "thesis AI call",
      shouldRetry: (err) => err instanceof HttpError && isRetryableStatus(err.status),
    }
  );

  const rows = parseThesisResponse(data.choices?.[0]?.message?.content ?? "");
  const theses: ThesisRow[] = [];
  for (const row of rows) {
    const snap = snapshots[row.index - 1];
    if (!snap || !row.bullCase || !row.bearCase) continue;
    theses.push({
      ticker: snap.ticker,
      bull_case: row.bullCase.slice(0, 600),
      bear_case: row.bearCase.slice(0, 600),
      confidence: Math.min(10, Math.max(1, Math.round(row.confidence) || 5)),
      key_drivers: Array.isArray(row.keyDrivers) ? row.keyDrivers.slice(0, 4).map((d) => String(d).slice(0, 80)) : [],
    });
  }

  if (theses.length) {
    const ok = await supabase.upsertTickerTheses(theses);
    logger.info(`Thesis: generated ${theses.length}/${snapshots.length} theses${ok ? ", stored in Supabase" : " (Supabase store failed)"}`);
  } else {
    logger.warn(`Thesis: AI returned 0 usable rows for ${snapshots.length} tickers`);
  }

  return theses;
}
