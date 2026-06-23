import { config } from "./config";
import { logger } from "./utils/logger";
import { collectArticles } from "./collector/rss";
import { processArticles, NEWS_CATEGORIES } from "./processor/ai";
import { formatDigestTelegram } from "./formatter/telegram";
import {
  sendDigestMessage,
  startInteractiveBot,
  registerCommand,
} from "./sender/telegram";
import { deduplicateArticles } from "./utils/dedup";
import { fetchStockPrices } from "./utils/stocks";
import { supabase } from "./utils/supabase";
import type { Article } from "./collector/rss";
import type { FeedResult } from "./collector/rss";

const MAX_ARTICLES_FOR_AI = 35;

async function main() {    logger.info("🚀 AI Infrastructure Daily Digest — Starting");

  const startTime = Date.now();
  const runDate = new Date().toISOString().split("T")[0];
  let digestRunId: number | null = null;

  // Start interactive bot (registers /start, /help, etc.)
  startInteractiveBot();

  try {
    // ─── Step 1: Collect News ────────────────────
    logger.info("Step 1/4: Collecting news from RSS feeds...");
    const { articles, feedStatuses } = await collectArticles();

    // ─── Health Alert: Check feed failure rate ────
    if (supabase.isConfigured()) {
      await checkFeedHealth(feedStatuses);
    }

    if (articles.length === 0) {
      logger.warn("No articles collected. Sending alert...");
      await sendDigestMessage(
        "⚠️ <b>AI Infra Digest</b> — No articles were collected today.\n\n" +
          "This could mean: RSS feeds are down, or no AI-relevant articles were found.\n" +
          "Check the logs for details."
      );
      return;
    }

    // ─── Step 1b: Deduplicate ───────────────────
    logger.info(`Step 1b: Deduplicating ${articles.length} articles...`);
    const uniqueArticles = deduplicateArticles(articles);

    let articlesToProcess: Article[];
    if (uniqueArticles.length === 0) {
      logger.info("All articles were duplicates; processing top articles anyway");
      articlesToProcess = articles.slice(0, MAX_ARTICLES_FOR_AI);
    } else {
      articlesToProcess = uniqueArticles.slice(0, MAX_ARTICLES_FOR_AI);
    }

    logger.info(
      `Processing ${articlesToProcess.length}/${articles.length} articles ` +
        `(dedup skipped ${articles.length - uniqueArticles.length}, ` +
        `capped at ${MAX_ARTICLES_FOR_AI})`
    );

    // ─── Step 2: AI Processing ───────────────────
    logger.info(`Step 2/4: Processing articles with AI (${articlesToProcess.length} articles)...`);
    const digest = await processArticles(articlesToProcess);

    // ─── Step 2b: Fetch Stock Prices ────────────
    const allTickers = [
      ...new Set([
        ...digest.articles.flatMap((a) => a.affectedStocks),
        ...digest.topStocks.map((s) => s.ticker),
      ]),
    ];
    const stockPrices = await fetchStockPrices(allTickers);

    // ─── Step 3: Format Digest ───────────────────
    logger.info("Step 3/4: Formatting digest for Telegram...");
    const formattedMessage = formatDigestTelegram(digest, { stockPrices });

    // ─── Step 4: Send to Telegram ───────────────
    logger.info("Step 4/4: Sending digest to Telegram...");
    const sendResult = await sendDigestMessage(formattedMessage);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (sendResult.success) {
      logger.info(
        `✅ Digest delivered successfully in ${elapsed}s — ` +
          `${digest.articles.length} articles, ${stockPrices.size} prices, ${digest.topStocks.length} stocks`
      );
    } else {
      logger.error("Failed to deliver digest", { error: sendResult.error });
    }

    // ─── Step 5: Write to Supabase ──────────────
    if (supabase.isConfigured()) {
      logger.info("Step 5/5: Writing metrics to Supabase...");

      // Create digest run record
      digestRunId = await supabase.createDigestRun({
        run_date: runDate,
        status: sendResult.success ? "success" : "failed",
        articles_collected: articles.length,
        articles_processed: digest.articles.length,
        batches_run: Math.ceil(articlesToProcess.length / 10),
        ai_provider: "groq",
        ai_model: "llama-3.3-70b-versatile",
        total_tokens_used: digest.usage.totalTokens,
        duration_seconds: parseFloat(elapsed),
        error_message: sendResult.success ? undefined : sendResult.error,
      });

      if (digestRunId) {
        // Articles
        await supabase.insertArticles(
          digestRunId,
          digest.articles.map((a) => ({
            title: a.title,
            url: a.url,
            source: a.source,
            impact: a.impact,
            impact_score: a.impactScore,
            category: a.category,
            affected_stocks: a.affectedStocks,
            summary: a.summary,
            reason: a.reason,
          }))
        );

        // Pipeline health
        await supabase.insertPipelineHealth(
          digestRunId,
          feedStatuses.map((f) => ({
            feed_name: f.name,
            feed_url: f.url,
            status: f.status,
            articles_fetched: f.articlesFetched,
            error_message: f.error,
          }))
        );
      }

      // Sector activity
      const sectorCounts: Record<string, { count: number; totalScore: number; bullish: number; bearish: number; neutral: number }> = {};
      for (const article of digest.articles) {
        const cat = article.category || NEWS_CATEGORIES[0];
        if (!sectorCounts[cat]) sectorCounts[cat] = { count: 0, totalScore: 0, bullish: 0, bearish: 0, neutral: 0 };
        sectorCounts[cat].count++;
        sectorCounts[cat].totalScore += article.impactScore;
        if (article.impact === "Bullish") sectorCounts[cat].bullish++;
        else if (article.impact === "Bearish") sectorCounts[cat].bearish++;
        else sectorCounts[cat].neutral++;
      }

      await supabase.updateSectorActivity(
        runDate,
        Object.entries(sectorCounts).map(([sector, data]) => ({
          sector,
          article_count: data.count,
          avg_impact_score: Math.round((data.totalScore / data.count) * 10) / 10,
          bullish_count: data.bullish,
          bearish_count: data.bearish,
          neutral_count: data.neutral,
        }))
      );

      // Stock mentions
      const mentionMap: Record<string, { count: number; totalSentiment: number; totalScore: number }> = {};
      for (const article of digest.articles) {
        for (const ticker of article.affectedStocks) {
          if (!mentionMap[ticker]) mentionMap[ticker] = { count: 0, totalSentiment: 0, totalScore: 0 };
          mentionMap[ticker].count++;
          mentionMap[ticker].totalSentiment += article.impact === "Bullish" ? 1 : article.impact === "Bearish" ? -1 : 0;
          mentionMap[ticker].totalScore += article.impactScore;
        }
      }

      await supabase.updateStockMentions(
        runDate,
        Object.entries(mentionMap).map(([ticker, data]) => ({
          ticker,
          mention_count: data.count,
          avg_sentiment: Math.round((data.totalSentiment / data.count) * 10) / 10,
          avg_impact_score: Math.round((data.totalScore / data.count) * 10) / 10,
          price: stockPrices.get(ticker)?.price,
          price_change_percent: stockPrices.get(ticker)?.changePercent
            ? Math.round(stockPrices.get(ticker)!.changePercent * 100) / 100
            : undefined,
        }))
      );

      // Stock prices
      await supabase.insertStockPrices(
        [...stockPrices.values()].map((sp) => ({
          date: runDate,
          ticker: sp.ticker,
          price: Math.round(sp.price * 100) / 100,
          change: Math.round(sp.change * 100) / 100,
          change_percent: Math.round(sp.changePercent * 100) / 100,
          previous_close: Math.round(sp.previousClose * 100) / 100,
        }))
      );

      // Daily metrics
      const healthyFeeds = feedStatuses.filter((f) => f.status === "success").length;
      const failingFeeds = feedStatuses.filter((f) => f.status === "failed").length;
      const activeSectors = Object.keys(digest.categories).length;

      // Estimate cost based on provider pricing
      const costPer1KTokens = 0.00015; // Groq Llama pricing ~$0.15/1M tokens
      const estimatedCost = digest.usage.totalTokens * costPer1KTokens / 1000;

      await supabase.updateDailyMetrics(runDate, {
        total_articles_processed: digest.articles.length,
        total_stocks_tracked: allTickers.length,
        sectors_active: activeSectors,
        feeds_healthy: healthyFeeds,
        feeds_failing: failingFeeds,
        total_tokens_used: digest.usage.totalTokens,
        estimated_cost: Math.round(estimatedCost * 1000000) / 1000000,
        top_sector: Object.entries(sectorCounts).sort((a, b) => b[1].count - a[1].count)[0]?.[0] || null,
        top_ticker: Object.entries(mentionMap).sort((a, b) => b[1].count - a[1].count)[0]?.[0] || null,
        digest_status: sendResult.success ? "success" : "failed",
      });

      logger.info("✅ Metrics written to Supabase");
    }

    // Exit cleanly so the polling loop doesn't keep the process alive in CI
    process.exit(0);

  } catch (error) {
    logger.error("Digest generation failed", {
      error: (error as Error).message,
      stack: (error as Error).stack?.slice(0, 500),
    });      // Record failure in Supabase
    if (supabase.isConfigured()) {
      await supabase.createDigestRun({
        run_date: runDate,
        status: "failed",
        articles_collected: 0,
        articles_processed: 0,
        batches_run: 0,
        ai_provider: "groq",
        ai_model: "llama-3.3-70b-versatile",
        total_tokens_used: 0,
        duration_seconds: ((Date.now() - startTime) / 1000),
        error_message: (error as Error).message,
      });
    }

    // Try to send error notification
    try {
      await sendDigestMessage(
        `⚠️ <b>AI Infra Digest — Error</b>\n\n` +
          `The daily digest failed to generate:\n<code>${(error as Error).message}</code>\n\n` +
          `Check the GitHub Actions logs for details.`
      );
    } catch {
      // Ignore send errors
    }

    process.exit(1);
  }
}

// ─── Feed Health Monitoring ────────────────────────────

/** Send an alert if >20% of RSS feeds are failing. */
async function checkFeedHealth(feedStatuses: FeedResult[]): Promise<void> {
  const total = feedStatuses.length;
  const failed = feedStatuses.filter((f) => f.status === "failed").length;
  const failRate = total > 0 ? failed / total : 0;

  if (failRate > 0.2) {
    const failedFeeds = feedStatuses
      .filter((f) => f.status === "failed")
      .slice(0, 10)
      .map((f) => `• <code>${f.name}</code>: ${f.error || "unknown error"}`)
      .join("\n");

    const alertText =
      `⚠️ <b>Feed Health Alert</b>\n\n` +
      `${failed}/${total} RSS feeds failed (${Math.round(failRate * 100)}%).\n\n` +
      `Failed feeds:\n${failedFeeds}\n\n` +
      `<i>Check the pipeline health dashboard for details.</i>`;

    await sendDigestMessage(alertText);
    logger.warn(`Feed health alert sent: ${failed}/${total} feeds failing`);
  }
}

// ─── Command Handlers (Interactive Bot) ───────────────

/** Register /digest, /sources, /last handlers for the interactive bot. */
export function registerDigestCommands(): void {
  registerCommand("digest", async () => {
    return "⏳ Run the daily digest via the GitHub Actions workflow or use <code>npm run dev</code> locally.\n\nUse /last to see the most recent digest summary.";
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
        `📡 <b>RSS Feeds (57 tracked)</b>\n\n` +
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

    const cfg = getSupabaseConfig();
    if (!cfg) return "Database not available.";

    try {
      const response = await fetch(
        `${cfg.url}/rest/v1/digest_runs?order=run_date.desc&limit=1&select=*`,
        {
          headers: {
            apikey: cfg.key,
            Authorization: `Bearer ${cfg.key}`,
          },
        }
      );
      if (!response.ok) return "Could not fetch latest digest.";
      const runs = (await response.json()) as Record<string, unknown>[];
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

function getSupabaseConfig(): { url: string; key: string } | null {
  const url = config.app.supabaseUrl;
  const key = config.app.supabaseServiceKey;
  return url && key ? { url, key } : null;
}

if (require.main === module) {
  registerDigestCommands();
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

export { main };
export type { FeedResult };
