/**
 * v9.1 — Cross-Source Grounding
 *
 * Enriches high-impact articles with a one-line note linking the news to
 * same-run SEC filings, earnings data, and stock price moves. Uses data
 * already loaded in memory — zero extra Supabase calls.
 */

import type { ProcessedArticle } from "../processor/ai";
import type { SECFinancialExtract } from "../processor/sec";
import type { EarningsAnalysis } from "../processor/earnings";
import type { StockPrice } from "./stocks";

function formatStockMove(price: StockPrice): string {
  const sign = price.changePercent > 0 ? "+" : "";
  return `${sign}${price.changePercent.toFixed(1)}%`;
}

interface GroundingCandidate {
  ticker: string;
  impact: number; // used to pick the single best match
  note: string;
}

function buildSecNote(ticker: string, extract: SECFinancialExtract): GroundingCandidate {
  const parts: string[] = [];
  if (extract.capex !== null) parts.push(`capex $${extract.capex.toFixed(0)}M`);
  if (extract.aiRevenue !== null) parts.push(`AI rev $${extract.aiRevenue.toFixed(0)}M`);
  const dateShort = extract.filingDate.slice(5); // MM-DD
  const note = `📊 ${ticker}: ${extract.formType} ${dateShort} (score ${extract.impactScore}/10)${parts.length ? " | " + parts.join(", ") : ""}`;
  return { ticker, impact: extract.impactScore, note };
}

function buildEarningsNote(ticker: string, analysis: EarningsAnalysis): GroundingCandidate {
  const parts: string[] = [];
  if (analysis.delta?.revenueGuidanceChangePct !== null && analysis.delta?.revenueGuidanceChangePct !== undefined) {
    const pct = analysis.delta.revenueGuidanceChangePct;
    parts.push(`rev guide ${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`);
  }
  if (analysis.tone.overall !== "neutral") {
    parts.push(`tone ${analysis.tone.overall}`);
  }
  const note = `📊 ${ticker}: Q${analysis.quarter} earnings${parts.length ? " | " + parts.join(", ") : ""}`;
  // Use tone confidence as a proxy for "impact" when no delta
  const impact = analysis.tone.confidence;
  return { ticker, impact, note };
}

function buildPriceNote(ticker: string, price: StockPrice): GroundingCandidate {
  const move = formatStockMove(price);
  const note = `📊 ${ticker}: ${move} today`;
  return { ticker, impact: Math.abs(price.changePercent), note };
}

/**
 * Attaches a `groundingNote` to each article that has matching tickers in the
 * same-run SEC extracts, earnings analyses, or stock prices. Mutates articles
 * in-place. Only adds a note when substantive data exists (SEC score ≥ 6,
 * earnings with delta or non-neutral tone, or stock move ≥ 1%).
 */
export function attachGroundingNotes(
  articles: ProcessedArticle[],
  secExtracts: SECFinancialExtract[],
  earningsAnalyses: EarningsAnalysis[],
  stockPrices: Map<string, StockPrice>,
): void {
  // Index SEC extracts and earnings by ticker for O(1) lookup
  const secByTicker = new Map<string, SECFinancialExtract>();
  for (const e of secExtracts) {
    const existing = secByTicker.get(e.ticker);
    if (!existing || e.impactScore > existing.impactScore) {
      secByTicker.set(e.ticker, e);
    }
  }

  const earningsByTicker = new Map<string, EarningsAnalysis>();
  for (const a of earningsAnalyses) {
    earningsByTicker.set(a.ticker, a);
  }

  for (const article of articles) {
    const candidates: GroundingCandidate[] = [];

    for (const ticker of article.affectedStocks) {
      const sec = secByTicker.get(ticker);
      if (sec && sec.impactScore >= 6) {
        candidates.push(buildSecNote(ticker, sec));
      }

      const earnings = earningsByTicker.get(ticker);
      if (earnings) {
        const hasData =
          (earnings.delta?.revenueGuidanceChangePct !== null && earnings.delta?.revenueGuidanceChangePct !== undefined) ||
          earnings.tone.overall !== "neutral";
        if (hasData) {
          candidates.push(buildEarningsNote(ticker, earnings));
        }
      }

      const price = stockPrices.get(ticker);
      if (price && Math.abs(price.changePercent) >= 1) {
        candidates.push(buildPriceNote(ticker, price));
      }
    }

    if (candidates.length === 0) continue;

    // Pick the single highest-impact candidate to keep digest concise
    candidates.sort((a, b) => b.impact - a.impact);
    article.groundingNote = candidates[0].note;
  }
}
