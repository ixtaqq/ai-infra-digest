import type { DigestResult } from "../processor/ai";
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
    case "positive":
      return "🟢";
    case "negative":
      return "🔴";
    default:
      return "⚪";
  }
}

function formatStockPrice(price: StockPrice): string {
  const arrow = price.changePercent > 0 ? "▲" : price.changePercent < 0 ? "▼" : "▬";
  const sign = price.changePercent > 0 ? "+" : "";
  return `${arrow} ${sign}${price.changePercent.toFixed(1)}%`;
}

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
  lines.push(`<i>${formatDate()}</i>`);
  lines.push("");

  // ─── Top News ─────────────────────────────────────
  lines.push("<b>📰 TOP NEWS</b>");
  lines.push("");

  const topArticles = digest.articles.slice(0, 10);

  topArticles.forEach((article, i) => {
    const emoji = impactEmoji(article.impactScore);
    lines.push(`${i + 1}. ${emoji} <b>${escapeHtml(article.title)}</b>`);
    lines.push(`   <i>${article.impact}</i> (${article.impactScore}/10)`);

    if (article.affectedStocks.length > 0) {
      lines.push(`   Stocks: ${article.affectedStocks.join(", ")}`);
    }

    if (article.url) {
      lines.push(`   <a href="${article.url}">Read more</a>`);
    }

    lines.push("");
  });

  // ─── Top Stocks with Prices ───────────────────────
  if (digest.topStocks.length > 0) {
    lines.push("<b>📊 TOP STOCKS</b>");
    lines.push("");

    digest.topStocks.slice(0, 8).forEach((stock) => {
      const price = prices?.get(stock.ticker);
      const emoji = sentimentEmoji(stock.sentiment);

      let line = `${emoji} <b>${stock.ticker}</b>`;
      if (price) {
        line += ` ${formatStockPrice(price)}`;
      }
      line += ` — ${escapeHtml(stock.reason)}`;

      lines.push(line);
    });

    // Add any extra stock prices not in top stocks
    if (prices) {
      const extraTickers = [...prices.keys()].filter(
        (t) => !digest.topStocks.some((s) => s.ticker === t)
      );
      if (extraTickers.length > 0) {
        lines.push("");
        lines.push("<b>💰 ADDITIONAL PRICES</b>");
        extraTickers.slice(0, 5).forEach((ticker) => {
          const price = prices!.get(ticker)!;
          lines.push(
            `   <b>${ticker}</b> ${formatStockPrice(price)}`
          );
        });
      }
    }

    lines.push("");
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

  // ─── Footer ──────────────────────────────────────
  lines.push("━".repeat(30));
  lines.push("<i>🤖 Powered by AI | Generated daily at 8 AM MYT</i>");
  lines.push("<i>📬 Not financial advice — DYOR</i>");

  return lines.join("\n");
}
