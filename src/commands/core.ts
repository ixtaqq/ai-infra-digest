import { config } from "../config";
import { registerCommand } from "../sender/telegram";
import { supabase } from "../utils/supabase";

export function registerCoreCommands(): void {
  registerCommand("digest", async (ctx) => {
    // Parse optional parameters: /digest watchlist, /digest sector=Chips
    const parts = ctx.text.split(/\s+/).slice(1);
    const useWatchlist = parts.includes("watchlist");
    const sectorParam = parts.find((p) => p.startsWith("sector="));
    const sector = sectorParam ? sectorParam.split("=")[1].replace(/_/g, " ") : null;

    if (!useWatchlist && !sector) {
      return "⏳ Run the daily digest via the GitHub Actions workflow or use <code>npm run dev</code> locally.\n\n" +
        "<b>Options:</b>\n" +
        "• <code>/digest watchlist</code> — Filter by your saved watchlist\n" +
        "• <code>/digest sector=Chips_&_GPUs</code> — Filter by sector\n" +
        "• Use /last to see the most recent digest summary.";
    }

    // Personalized digest mode — filter from Supabase
    if (!supabase.isConfigured()) {
      return "Supabase not configured. Connect it to use personalized digests.";
    }

    const prefs = await supabase.getUserPreferences(ctx.chatId);
    if (!prefs && (useWatchlist || sector)) {
      return "No preferences found. Use /watchlist to set your tickers, or /start to register.";
    }

    if (!supabase.isConfigured()) return "Database not available.";

    try {
      let articles = await supabase.queryRows<Record<string, unknown>>(
        "articles",
        "order=created_at.desc&limit=30&select=title,url,source,impact,impact_score,category,affected_stocks,summary"
      );

      // Filter by watchlist
      if (useWatchlist && prefs?.watchlist?.length) {
        const watchlist = prefs.watchlist.map((t: string) => t.toUpperCase());
        articles = articles.filter((a: Record<string, unknown>) =>
          ((a.affected_stocks as string[]) || []).some((s: string) => watchlist.includes(s))
        );
      }

      // Filter by sector
      if (sector) {
        articles = articles.filter((a: Record<string, unknown>) => a.category === sector);
      }

      if (articles.length === 0) {
        return "No matching articles found.";
      }

      const maxShow = Math.min(articles.length, 10);
      const lines = [`📋 <b>Filtered Digest</b> (${articles.length} articles)`];
      if (useWatchlist && prefs?.watchlist?.length) {
        lines.push(`Watchlist: <code>${prefs.watchlist.join(", ")}</code>`);
      }
      if (sector) lines.push(`Sector: ${sector}`);
      lines.push("");

      for (const a of articles.slice(0, maxShow)) {
        const score = a.impact_score as number;
        const emoji = score >= 8 ? "🔥" : score >= 6 ? "📈" : score >= 4 ? "📊" : "📌";
        lines.push(
          `${emoji} <b>${(a.title as string).replace(/</g, "&lt;").replace(/>/g, "&gt;")}</b>`
        );
        lines.push(`   ${a.impact as string} (${score}/10) | ${a.category as string}`);
        lines.push("");
      }

      if (articles.length > maxShow) {
        lines.push(`<i>... and ${articles.length - maxShow} more</i>`);
      }

      return { text: lines.join("\n") };
    } catch {
      return "Could not fetch personalized digest.";
    }
  });

  registerCommand("sources", async () => {
    // Use cached feed list from Supabase if available, otherwise show static list
    if (supabase.isConfigured()) {
      try {
        const healthUrl = `${config.app.supabaseUrl}/rest/v1/pipeline_health?select=feed_name,status,fetch_count,error_message&order=run_date.desc&limit=100`;
        const response = await fetch(healthUrl, {
          headers: {
            apikey: config.app.supabaseServiceKey!,
            Authorization: `Bearer ${config.app.supabaseServiceKey!}`,
          },
        });
        if (response.ok) {
          const data = (await response.json()) as { feed_name: string; status: string }[];
          // Count unique feed statuses (last seen for each)
          const feedMap = new Map<string, string>();
          for (const row of data) {
            if (!feedMap.has(row.feed_name)) {
              feedMap.set(row.feed_name, row.status);
            }
          }
          const healthy = [...feedMap.values()].filter((s) => s === "success").length;
          const failing = feedMap.size - healthy;
          return {
            text:
              `📡 <b>RSS Feeds (${feedMap.size})</b>\n\n` +
              `✅ Healthy: ${healthy}\n` +
              `❌ Failing: ${failing}\n\n` +
              `Tracked feeds cover: NVIDIA, AMD, Broadcom, Microsoft, Amazon, ` +
              `Google, Meta, TSMC, Intel, and 49 more across 10 sectors.\n\n` +
              `<i>Last checked: daily at 8 AM MYT</i>`,
          };
        }
      } catch {
        // Fall through to static list
      }
    }

    // Static fallback
    return {
      text:
        `📡 <b>RSS Feeds (68 tracked)</b>\n\n` +
        `<b>Tier 1 — Major Cos & Financial News (37):</b>\n` +
        `NVIDIA, AMD, Broadcom, Microsoft, Amazon, Google, Meta, TSMC, Intel, ` +
        `Qualcomm, Oracle, IBM, Micron, ASML, Super Micro, Dell, ARM, Arista, ` +
        `Cisco, Marvell, Applied Materials, Lam Research, KLA, Tokyo Electron, ` +
        `Digital Realty, Equinix, Constellation Energy, Vistra, GE Vernova, ` +
        `Siemens Energy, Vertiv, Schneider Electric, Eaton, Anthropic, xAI, ` +
        `Mistral AI, Cohere\n\n` +
        `<b>Tier 2 — Industry News (20):</b>\n` +
        `Tom's Hardware, AnandTech, Ars Technica, TechCrunch, The Verge, ` +
        `Seeking Alpha, SemiAnalysis, The Register, Datacenter Dynamics, ` +
        `Semiconductor Engineering, Google AI Blog, OpenAI, AWS AI, VentureBeat, ` +
        `AI News, Medium AI, AI Business, ZDNet AI\n\n` +
        `<b>Financial News:</b> MarketWatch, Yahoo Finance, CNBC, Reuters, ` +
        `Bloomberg Tech, FT Tech, Barron's, WSJ Markets, IBD, SEC Filings\n\n` +
        `<i>Feeds are checked daily at 8 AM MYT</i>`,
    };
  });

  registerCommand("last", async () => {
    if (!supabase.isConfigured()) {
      return "Supabase not configured. Run the digest locally with <code>npm run dev</code> to see results.";
    }

    try {
      const runs = await supabase.queryRows<Record<string, unknown>>(
        "digest_runs",
        "order=run_date.desc&limit=1&select=*"
      );
      if (!runs?.length) return "No digest runs found yet.";

      const run = runs[0];
      const date = run.run_date as string;
      const status = run.status as string;
      const articles = run.articles_processed as number;
      const tokens = run.total_tokens_used as number;
      const duration = run.duration_seconds as number;

      return {
        text:
          `📋 <b>Latest Digest</b>\n\n` +
          `Date: ${date}\n` +
          `Status: ${status === "success" ? "✅ Success" : "❌ Failed"}\n` +
          `Articles processed: ${articles}\n` +
          `Tokens used: ${tokens?.toLocaleString() || "N/A"}\n` +
          `Duration: ${duration?.toFixed(1) || "N/A"}s\n\n` +
          `<i>Run /digest to generate a new one</i>`,
      };
    } catch {
      return "Could not connect to database.";
    }
  });
}
