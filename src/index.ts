import { logger } from "./utils/logger";
import { collectArticles } from "./collector/rss";
import { processArticles } from "./processor/ai";
import { formatDigestTelegram } from "./formatter/telegram";
import { sendDigestMessage } from "./sender/telegram";
import { deduplicateArticles } from "./utils/dedup";
import { fetchStockPrices } from "./utils/stocks";
import type { Article } from "./collector/rss";

const MAX_ARTICLES_FOR_AI = 35;

async function main() {
  logger.info("🚀 AI Infrastructure Daily Digest — Starting");

  const startTime = Date.now();

  try {
    // ─── Step 1: Collect News ────────────────────
    logger.info("Step 1/4: Collecting news from RSS feeds...");
    const articles = await collectArticles();

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
      // All articles were duplicates; force process top articles anyway
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
    const formattedMessage = formatDigestTelegram(digest, {
      stockPrices,
    });

    // ─── Step 4: Send to Telegram ───────────────
    logger.info("Step 4/4: Sending digest to Telegram...");
    const result = await sendDigestMessage(formattedMessage);

    if (result.success) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(
        `✅ Digest delivered successfully in ${elapsed}s — ` +
          `${digest.articles.length} articles analyzed, ` +
          `${stockPrices.size} stock prices, ` +
          `${digest.topStocks.length} stocks tracked`
      );
    } else {
      logger.error("Failed to deliver digest", { error: result.error });
      process.exit(1);
    }
  } catch (error) {
    logger.error("Digest generation failed", {
      error: (error as Error).message,
      stack: (error as Error).stack?.slice(0, 500),
    });

    // Try to send error notification
    try {
      await sendDigestMessage(
        `⚠️ <b>AI Infra Digest — Error</b>\n\n` +
          `The daily digest failed to generate:\n<code>${(error as Error).message}</code>\n\n` +
          `Check the GitHub Actions logs for details.`
      );
    } catch {
      // Ignore send errors in error handler
    }

    process.exit(1);
  }
}

// Run if this is the main module
if (require.main === module) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

export { main };
