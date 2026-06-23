import { logger } from "./utils/logger";
import { collectArticles } from "./collector/rss";
import { processArticles, NEWS_CATEGORIES } from "./processor/ai";
import { formatDigestTelegram } from "./formatter/telegram";
import { sendDigestMessage } from "./sender/telegram";
import { deduplicateArticles } from "./utils/dedup";
import { fetchStockPrices } from "./utils/stocks";
import { supabase } from "./utils/supabase";
import type { Article } from "./collector/rss";

const MAX_ARTICLES_FOR_AI = 35;

async function main() {
  logger.info("🚀 AI Infrastructure Daily Digest — Starting");

  const startTime = Date.now();
  const runDate = new Date().toISOString().split("T")[0];
  let digestRunId: number | null = null;

  try {
    // ─── Step 1: Collect News ────────────────────
    logger.info("Step 1/4: Collecting news from RSS feeds...");
    const { articles, feedStatuses } = await collectArticles();

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
        total_tokens_used: 0, // Tracked separately if needed
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

      await supabase.updateDailyMetrics(runDate, {
        total_articles_processed: digest.articles.length,
        total_stocks_tracked: allTickers.length,
        sectors_active: activeSectors,
        feeds_healthy: healthyFeeds,
        feeds_failing: failingFeeds,
        total_tokens_used: 0,
        estimated_cost: 0,
        top_sector: Object.entries(sectorCounts).sort((a, b) => b[1].count - a[1].count)[0]?.[0] || null,
        top_ticker: Object.entries(mentionMap).sort((a, b) => b[1].count - a[1].count)[0]?.[0] || null,
        digest_status: sendResult.success ? "success" : "failed",
      });

      logger.info("✅ Metrics written to Supabase");
    }

  } catch (error) {
    logger.error("Digest generation failed", {
      error: (error as Error).message,
      stack: (error as Error).stack?.slice(0, 500),
    });

    // Record failure in Supabase
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

if (require.main === module) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

export { main };
