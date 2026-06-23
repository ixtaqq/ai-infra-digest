import type { DigestResult, NewsCategory } from "../processor/ai";
import type { StockPrice } from "../utils/stocks";

function formatDate(): string {
  const now = new Date();
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
}

function impactEmoji(score: number): string {
  if (score >= 8) return "🔥";
  if (score >= 6) return "📈";
  if (score >= 4) return "📊";
  return "📌";
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface FormatOptions {
  stockPrices?: Map<string, StockPrice>;
}

export function formatDigestTelegram(
  digest: DigestResult,
  options?: FormatOptions
): string {
  const lines: string[] = [];
  const prices = options?.stockPrices;

  // ─── Header ───────────────────────────────────────
  lines.push("🚀 <b>AI Infra Morning Digest</b>");
  lines.push(`<i>${formatDate()} • Full value chain coverage</i>`);
  lines.push("");

  // ─── Top Stocks with Prices (compact) ─────────────
  if (digest.topStocks.length > 0) {
    lines.push("<b>📊 TOP MOVERS</b>");
    const topStocks = digest.topStocks.slice(0, 10);
    lines.push(
      topStocks
        .map((stock) => {
          const price = prices?.get(stock.ticker);
          const emoji = sentimentEmoji(stock.sentiment);
          const priceStr = price ? ` ${formatStockPrice(price)}` : "";
          return `${emoji} <b>${stock.ticker}</b>${priceStr}`;
        })
        .join(" • ")
    );
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

  lines.push("<b>📰 NEWS BY SECTOR</b>");
  lines.push("");

  let articleCount = 0;
  const MAX_ARTICLES = 15;

  for (const cat of categoryOrder) {
    const catArticles = digest.categories[cat as NewsCategory];
    if (!catArticles?.length) continue;
    if (articleCount >= MAX_ARTICLES) break;

    const emoji = CATEGORY_EMOJIS[cat] || "📌";
    lines.push(`${emoji} <b>${escapeHtml(cat)}</b>`);

    const remaining = MAX_ARTICLES - articleCount;
    const articlesToShow = catArticles.slice(0, Math.min(remaining, 3));

    articlesToShow.forEach((article) => {
      articleCount++;
      const impactIcon = impactEmoji(article.impactScore);
      lines.push(
        `  ${impactIcon} ${escapeHtml(article.title)}`
      );
      lines.push(
        `   <i>${article.impact}</i> (${article.impactScore}/10) ` +
        `| Stocks: ${article.affectedStocks.slice(0, 3).join(", ") || "N/A"}`
      );
      if (article.url) {
        lines.push(`   <a href="${article.url}">Read</a>`);
      }
    });

    lines.push("");
  }

  if (articleCount === 0 && digest.articles.length > 0) {
    // Fallback: show articles without categories
    lines.push("<b>📰 TOP NEWS</b>");
    digest.articles.slice(0, 8).forEach((article, i) => {
      const emoji = impactEmoji(article.impactScore);
      lines.push(`${i + 1}. ${emoji} <b>${escapeHtml(article.title)}</b>`);
      lines.push(`   <i>${article.impact}</i> (${article.impactScore}/10)`);
      if (article.url) lines.push(`   <a href="${article.url}">Read</a>`);
      lines.push("");
    });
  }

  // ─── Market Outlook ─────────────────────────────
  lines.push("<b>🎯 MARKET OUTLOOK</b>");
  lines.push("");
  lines.push(escapeHtml(digest.marketOutlook));
  lines.push("");

  // ─── Summary ─────────────────────────────────────
  if (digest.summary) {
    lines.push("<b>📝 SUMMARY</b>");
    lines.push("");
    lines.push(escapeHtml(digest.summary));
    lines.push("");
  }

  // ─── Value Chain Coverage Indicator ───────────────
  const activeCategories = Object.keys(digest.categories).filter(
    (c) => digest.categories[c as NewsCategory]?.length > 0
  );
  if (activeCategories.length > 0) {
    lines.push("<b>🔬 VALUE CHAIN COVERAGE</b>");
    lines.push(
      activeCategories
        .map((c) => `${CATEGORY_EMOJIS[c] || "📌"} ${c}`)
        .join(" • ")
    );
    lines.push("");
  }

  // ─── Footer ──────────────────────────────────────
  lines.push("━".repeat(30));
  lines.push("<i>🤖 Powered by AI | Generated daily at 8 AM MYT</i>");
  lines.push("<i>📬 Not financial advice — DYOR</i>");

  return lines.join("\n");
}
