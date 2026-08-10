import { registerCommand } from "../sender/telegram";
import type { TrendingItem } from "../pipeline/trending";
import { escapeHtml } from "../utils/escape";
import { queryDerivedMetrics } from "../utils/derived-metrics";
import { supabase } from "../utils/supabase";
import { getTrustScores } from "../utils/trust-scores";

export function registerTrendCommands(): void {
  registerCommand("trending", async (ctx) => {
    if (!supabase.isConfigured()) {
      return "Supabase not configured. Run the digest first to see trends.";
    }

    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
      const metrics = await supabase.queryRows<Record<string, unknown>>(
        "daily_metrics",
        `select=date,trending_json,trending_entities&date=gte.${encodeURIComponent(sevenDaysAgo)}&order=date.desc`
      );
      if (!metrics.length) return "No trending data available yet. Run the daily digest first.";

      const latest = metrics.find((m) => m.trending_json);
      if (!latest) return "No trending data available yet.";

      let trending: TrendingItem[];
      try {
        trending = JSON.parse(latest.trending_json as string) as TrendingItem[];
      } catch {
        return "Could not parse trending data.";
      }

      if (!trending.length) return "No trending entities found.";

      const lines = [`🔥 <b>Trending Now</b> — ${latest.date as string}`, ""];

      for (const item of trending.slice(0, 8)) {
        const typeEmoji =
          item.type === "ticker" ? "📈" :
          item.type === "sector" ? "📊" :
          item.type === "company" ? "🏢" : "🔑";
        const sentimentEmoji =
          item.dominantSentiment === "positive" ? "🟢" :
          item.dominantSentiment === "negative" ? "🔴" : "⚪";

        lines.push(`${typeEmoji} <b>${escapeHtml(item.entity)}</b> ${sentimentEmoji}`);
        lines.push(`   ${item.mentionCount} mentions, avg score ${item.avgScore}/10`);
        if (item.topArticles.length) {
          lines.push(`   📰 <a href="${item.topArticles[0].url}">${escapeHtml(item.topArticles[0].title.slice(0, 80))}</a>`);
        }
        lines.push("");
      }

      lines.push("<i>Last 7 days • Use /digest to generate fresh data</i>");
      return { text: lines.join("\n") };
    } catch {
      return "Could not fetch trending data.";
    }
  });

  registerCommand("trends", async (ctx) => {
    if (!supabase.isConfigured()) {
      return "Supabase not configured. Run the digest first to populate trends.";
    }

    // Parse "/trends NVDA 30d" or "/trends sector Datacenters 30d"
    const parts = ctx.text.split(/\s+/).slice(1);
    const daysMatch = parts.find((p: string) => /^\d+d$/i.test(p));
    const days = daysMatch ? parseInt(daysMatch, 10) : 30;
    const entityTypePart: "ticker" | "sector" = parts.find((p: string) => p.toLowerCase() === "sector") ? "sector" : "ticker";
    const entityParts = parts.filter((p: string) => p !== daysMatch && p.toLowerCase() !== "sector");
    const entity = entityParts.join(" ").toUpperCase() || "NVDA";

    try {
      const rows = await queryDerivedMetrics(entityTypePart, entity, days);
      if (!rows.length) {
        return `No data found for <b>${escapeHtml(entity)}</b> over the last ${days} days. Run more digests to build history.`;
      }

      // Sparkline from mention_count
      const counts = rows.map((r) => r.mention_count);
      const maxCount = Math.max(...counts, 1);
      const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
      const sparkline = counts.map((c) => blocks[Math.min(Math.floor((c / maxCount) * 7), 7)]).join("");

      // WoW delta (today vs 7 days ago)
      const today = rows[rows.length - 1];
      const weekAgo = rows.length >= 8 ? rows[rows.length - 8] : rows[0];
      const delta = today.mention_count - weekAgo.mention_count;
      const pct = weekAgo.mention_count > 0 ? Math.round((delta / weekAgo.mention_count) * 100) : 0;
      const wowLine = pct >= 0
        ? `📈 Mentions <b>+${pct}%</b> WoW (${weekAgo.mention_count} → ${today.mention_count})`
        : `📉 Mentions <b>${pct}%</b> WoW (${weekAgo.mention_count} → ${today.mention_count})`;

      const lines = [
        `📊 <b>${escapeHtml(entity)}</b> · Last ${rows.length}d`,
        `<code>${sparkline}</code>`,
        wowLine,
      ];

      if (today.price_close) {
        const priceChange = today.price_change_pct ?? 0;
        const priceEmoji = priceChange >= 0 ? "🟢" : "🔴";
        lines.push(`${priceEmoji} $${today.price_close.toFixed(2)} (${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(2)}%)`);
      }
      if (today.avg_impact_score) {
        lines.push(`⚡ Avg impact score: ${today.avg_impact_score.toFixed(1)}/10`);
      }

      lines.push("", `<i>${rows[0].date} → ${today.date} · ${entityTypePart}</i>`);
      return { text: lines.join("\n") };
    } catch {
      return "Could not fetch trends data.";
    }
  });

  registerCommand("sources quality", async () => {
    if (!supabase.isConfigured()) {
      return "Supabase not configured. Connect it to track source quality.";
    }
    try {
      const scores = await getTrustScores();
      if (scores.source.size === 0) {
        return "Not enough data — need at least 3 votes per source. Click 👍/👎 in validation prompts to start building quality scores.";
      }
      const lines = ["<b>📊 Source Quality Scores</b>", "<i>Based on 👍/👎 votes from the last 30 days</i>", ""];
      for (const [src, mult] of [...scores.source.entries()].sort((a, b) => b[1] - a[1])) {
        const bar = mult >= 1.1 ? "🟢" : mult <= 0.9 ? "🔴" : "🟡";
        lines.push(`${bar} ${src}: ×${mult.toFixed(2)}`);
      }
      lines.push("", "<i>🟢 ≥1.1 boosted · 🟡 neutral · 🔴 ≤0.9 penalised</i>");
      return { text: lines.join("\n") };
    } catch {
      return "Could not fetch source quality scores.";
    }
  });
}
