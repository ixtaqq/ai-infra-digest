import type { DigestResult, NewsCategory } from "../processor/ai";
import type { StockPrice } from "../utils/stocks";
import type { SECFinancialExtract } from "../processor/sec";
import { escapeHtml } from "../utils/escape";
import { formatRankingSummary } from "../utils/ranking";

function formatDate(): string {
  const now = new Date();
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
}

function impactBadge(impact: string): string {
  switch (impact) {
    case "Bullish": return "🟢 Bullish";
    case "Bearish": return "🔴 Bearish";
    default: return "⚪ Neutral";
  }
}

const DIVIDER = "━".repeat(16);

function sectionHeader(title: string): string[] {
  return [DIVIDER, `<b>${title}</b>`, ""];
}

function formatMillions(value: number): string {
  return value >= 1000 ? `$${(value / 1000).toFixed(1)}B` : `$${value.toFixed(0)}M`;
}

function formatPct(value: number, digits = 1): string {
  const arrow = value >= 0 ? "▲" : "▼";
  return `${arrow} ${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function sentimentEmoji(sentiment: string): string {
  switch (sentiment) {
    case "positive": return "🟢";
    case "negative": return "🔴";
    default: return "⚪";
  }
}

function formatStockPrice(price: StockPrice): string {
  const arrow = price.changePercent > 0 ? "▲" : price.changePercent < 0 ? "▼" : "▬";
  const sign = price.changePercent > 0 ? "+" : "";
  return `${arrow} ${sign}${price.changePercent.toFixed(1)}%`;
}

const CATEGORY_EMOJIS: Record<string, string> = {
  "Chips & GPUs": "💾",
  "Cloud & Hyperscalers": "☁️",
  "Datacenters": "🏢",
  "Networking": "🔗",
  "Power & Utilities": "⚡",
  "Cooling Infrastructure": "❄️",
  "AI Models & Labs": "🧠",
  "Semiconductor Manufacturing": "🏭",
  "M&A and Partnerships": "🤝",
  "Earnings & Guidance": "📊",
};

import type { EarningsAnalysis } from "../processor/earnings";
import type { DeepDiveResult } from "../processor/bear-cases";

export interface FormatOptions {
  editionDate?: string;
  stockPrices?: Map<string, StockPrice>;
  secExtracts?: SECFinancialExtract[];
  earningsAnalyses?: EarningsAnalysis[];
  personalizationNote?: string;
  whatChanged?: string;
  deepDive?: DeepDiveResult;
  digestLength?: "brief" | "standard" | "detailed";
}

export function formatDigestTelegram(
  digest: DigestResult,
  options?: FormatOptions
): string {
  const lines: string[] = [];
  const prices = options?.stockPrices;
  const digestLength = options?.digestLength ?? "standard";

  // ─── Header ───────────────────────────────────────
  lines.push("🚀 <b>AI Infra Morning Digest</b>");
  lines.push(`<i>${escapeHtml(options?.editionDate || formatDate())}</i>`);
  if (options?.personalizationNote) {
    lines.push(`<i>🎯 ${escapeHtml(options.personalizationNote)}</i>`);
  }
  lines.push("");

  // ─── TL;DR ────────────────────────────────────────
  if (digest.summary) {
    lines.push("⚡ <b>TL;DR</b>");
    lines.push(escapeHtml(digest.summary));
    lines.push("");
  }

  // ─── Top Stocks with Prices (one per line) ────────
  if (digest.topStocks.length > 0) {
    lines.push("📊 <b>Top movers</b>");
    for (const stock of digest.topStocks.slice(0, 10)) {
      const price = prices?.get(stock.ticker);
      const priceStr = price ? `  ${formatStockPrice(price)}` : "";
      lines.push(`${sentimentEmoji(stock.sentiment)} <b>${escapeHtml(stock.ticker)}</b>${priceStr}`);
    }
    if (prices?.size) lines.push("<i>Saved price snapshots, not live quotes.</i>");
    lines.push("");
  }

  if (options?.whatChanged) {
    lines.push(options.whatChanged);
    lines.push("");
  }

  // ─── News by Category ─────────────────────────────
  const categoryOrder = [
    "Chips & GPUs",
    "Cloud & Hyperscalers",
    "Datacenters",
    "Networking",
    "Semiconductor Manufacturing",
    "Power & Utilities",
    "Cooling Infrastructure",
    "AI Models & Labs",
    "Earnings & Guidance",
    "M&A and Partnerships",
  ];

  let articleCount = 0;
  const MAX_ARTICLES = 15;

  const pushArticle = (article: DigestResult["articles"][number]) => {
    articleCount++;
    const secBadge = article.isSECFiling ? " 🏛️" : "";
    const title = `<b>${escapeHtml(article.title)}</b>`;
    lines.push(
      `${articleCount}. ${article.url ? `<a href="${escapeHtml(article.url)}">${title}</a>` : title}${secBadge}`
    );
    const meta = [impactBadge(article.impact), `${article.impactScore}/10`];
    const tickers = article.affectedStocks.slice(0, 3).map(escapeHtml).join(", ");
    if (tickers) meta.push(tickers);
    lines.push(meta.join(" · "));
    if (article.summary) lines.push(escapeHtml(article.summary));
    if (digestLength === "detailed" && article.reason) {
      lines.push(`💡 <i>${escapeHtml(article.reason)}</i>`);
    }
    if (digestLength === "detailed" && article.rankingExplanation) {
      lines.push(`📐 <i>${escapeHtml(formatRankingSummary(article.rankingExplanation))}</i>`);
    }
    if (article.bearCase) lines.push(`⚠️ <i>${escapeHtml(article.bearCase)}</i>`);
    if (article.groundingNote) lines.push(article.groundingNote);
    lines.push("");
  };

  for (const cat of categoryOrder) {
    const catArticles = digest.categories[cat as NewsCategory];
    if (!catArticles?.length) continue;
    if (articleCount >= MAX_ARTICLES) break;

    const emoji = CATEGORY_EMOJIS[cat] || "📌";
    lines.push(...sectionHeader(`${emoji} ${escapeHtml(cat)}`));

    const remaining = MAX_ARTICLES - articleCount;
    catArticles.slice(0, Math.min(remaining, 3)).forEach(pushArticle);
  }

  if (articleCount === 0 && digest.articles.length > 0) {
    // Fallback: show articles without categories
    lines.push(...sectionHeader("📰 TOP NEWS"));
    digest.articles.slice(0, 8).forEach(pushArticle);
  }

  // ─── Market Outlook ─────────────────────────────
  lines.push(...sectionHeader("🎯 MARKET OUTLOOK"));
  lines.push(escapeHtml(digest.marketOutlook));
  lines.push("");

  // ─── 🎙️ Earnings Watch ────────────────────────────
  const earnings = options?.earningsAnalyses;
  if (earnings && earnings.length > 0) {
    lines.push(...sectionHeader("🎙️ EARNINGS WATCH"));
    for (const analysis of earnings.slice(0, 3)) {
      const toneEmoji = analysis.tone.overall === "bullish" ? "🟢" :
        analysis.tone.overall === "cautious" ? "🟡" :
        analysis.tone.overall === "bearish" ? "🔴" : "⚪";
      lines.push(`<b>${escapeHtml(analysis.companyName)} (${escapeHtml(analysis.ticker)})</b> · Q${analysis.quarter} ${analysis.year}`);

      const dataParts: string[] = [];
      if (analysis.metrics.revenueGuidance !== null) dataParts.push(`Rev guide ${formatMillions(analysis.metrics.revenueGuidance)}`);
      if (analysis.metrics.capexGuidance !== null) dataParts.push(`Capex guide ${formatMillions(analysis.metrics.capexGuidance)}`);
      if (analysis.metrics.aiRevenueMentioned !== null) dataParts.push(`AI rev ${formatMillions(analysis.metrics.aiRevenueMentioned)}`);
      if (analysis.metrics.capexSpend !== null) dataParts.push(`Capex ${formatMillions(analysis.metrics.capexSpend)}`);
      if (dataParts.length > 0) lines.push(dataParts.join(" · "));

      // Show guidance delta
      if (analysis.delta) {
        const deltaParts: string[] = [];
        if (analysis.delta.revenueGuidanceChangePct !== null) {
          deltaParts.push(`Rev ${formatPct(analysis.delta.revenueGuidanceChangePct)}`);
        }
        if (analysis.delta.capexGuidanceChangePct !== null) {
          deltaParts.push(`Capex ${formatPct(analysis.delta.capexGuidanceChangePct)}`);
        }
        if (deltaParts.length > 0) {
          const dirEmoji = analysis.delta.toneDirection === "improving" ? "📈" :
            analysis.delta.toneDirection === "worsening" ? "📉" : "➡️";
          lines.push(`${dirEmoji} Guidance vs last Q: ${deltaParts.join(" · ")}`);
        }
      }

      const tone = analysis.tone.overall.charAt(0).toUpperCase() + analysis.tone.overall.slice(1);
      lines.push(`${toneEmoji} Tone: ${tone} (${analysis.tone.confidence}/10)`);
      if (analysis.tone.keyPhrase) {
        lines.push(`<i>"${escapeHtml(analysis.tone.keyPhrase.slice(0, 120))}"</i>`);
      }
      lines.push("");
    }
  }

  // ─── SEC Filing Highlights (top 1-2 most impactful) ─
  const secExtracts = options?.secExtracts;
  if (secExtracts && secExtracts.length > 0 && secExtracts[0].impactScore >= 7) {
    lines.push(...sectionHeader("📜 SEC HIGHLIGHTS"));
    for (const extract of secExtracts.slice(0, 2)) {
      lines.push(`<b>${escapeHtml(extract.companyName)} (${escapeHtml(extract.ticker)})</b> · ${escapeHtml(extract.formType)}`);
      const data: string[] = [];
      if (extract.capex !== null) data.push(`Capex ${formatMillions(extract.capex)}`);
      if (extract.capexGuidance !== null) data.push(`Capex guide ${formatMillions(extract.capexGuidance)}`);
      if (extract.aiRevenue !== null) {
        const g = extract.aiRevenueGrowthPct !== null ? ` (${extract.aiRevenueGrowthPct >= 0 ? "+" : ""}${extract.aiRevenueGrowthPct.toFixed(0)}%)` : "";
        data.push(`AI rev ${formatMillions(extract.aiRevenue)}${g}`);
      }
      if (extract.grossMargin !== null) data.push(`GM ${extract.grossMargin.toFixed(1)}%`);
      if (extract.operatingMargin !== null) data.push(`OM ${extract.operatingMargin.toFixed(1)}%`);
      if (extract.revenueGuidance !== null) data.push(`Rev guide ${formatMillions(extract.revenueGuidance)}`);
      if (data.length > 0) lines.push(data.join(" · "));
      for (const takeaway of extract.keyTakeaways.slice(0, 2)) {
        lines.push(`• <i>${escapeHtml(takeaway)}</i>`);
      }
      lines.push("");
    }
  }

  // ─── Daily Deep-Dive (v9.2) ────────────────────────
  const deepDive = options?.deepDive;
  if (deepDive) {
    lines.push(...sectionHeader("🔬 DAILY DEEP-DIVE"));
    lines.push(`<b>${escapeHtml(deepDive.title)}</b>`);
    lines.push(`🟢 <b>Bull:</b> ${escapeHtml(deepDive.bullCase)}`);
    lines.push(`🔴 <b>Bear:</b> ${escapeHtml(deepDive.bearCase)}`);
    if (deepDive.contextNote) {
      lines.push(`📊 <i>${escapeHtml(deepDive.contextNote)}</i>`);
    }
    lines.push("");
  }

  // ─── Footer ──────────────────────────────────────
  lines.push(DIVIDER);
  lines.push("<i>🤖 AI-generated daily at 8 AM MYT · Not financial advice — DYOR</i>");

  return lines.join("\n");
}
