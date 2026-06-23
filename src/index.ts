import { config } from "./config";
import { logger } from "./utils/logger";
import { collectArticles, skipFeed, resetSkippedFeeds } from "./collector/rss";
import { processArticles, NEWS_CATEGORIES } from "./processor/ai";
import { formatDigestTelegram } from "./formatter/telegram";
import {
  sendDigestMessage,
  sendDigestMessageToUser,
  startInteractiveBot,
  registerCommand,
} from "./sender/telegram";
import { deduplicateArticles } from "./utils/dedup";
import { fetchStockPrices } from "./utils/stocks";
import { supabase } from "./utils/supabase";
import {
  emitFeedFetch,
  emitStockFetch,
  emitDigestDelivery,
  emitError,
} from "./utils/metrics";
import { collectSECFilings, getTopFilings } from "./collector/sec";
import { analyzeSECFilings } from "./processor/sec";
import type { Article, FeedResult } from "./collector/rss";
import type { SECFinancialExtract } from "./processor/sec";

const MAX_ARTICLES_FOR_AI = 35;

/**
 * Run the full digest pipeline — collect, dedup, AI process, format, deliver.
 * If `targetChatId` is provided, sends the digest to that user instead of
 * the default chat, and logs per-user delivery to user_delivery_log.
 *
 * Returns true on success, false on failure.
 */
export async function runPipeline(targetChatId?: number): Promise<boolean> {
  const startTime = Date.now();
  const runDate = new Date().toISOString().split("T")[0];
  let digestRunId: number | null = null;
  let overallSuccess = false;

  try {
    // ─── Conditional RSS: skip consistently failing feeds ──
    const skipFeeds = new Set<string>();
    if (supabase.isConfigured()) {
      try {
        const cfg = getSupabaseConfig()!;
        const resp = await fetch(
          `${cfg.url}/rest/v1/pipeline_health?select=feed_name,status&order=created_at.desc&limit=200`,
          { headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` } }
        );
        if (resp.ok) {
          const data = (await resp.json()) as { feed_name: string; status: string }[];
          // Count consecutive failures per feed
          const lastSeen = new Map<string, { fails: number; checked: boolean }>();
          for (const row of data) {
            const entry = lastSeen.get(row.feed_name) || { fails: 0, checked: false };
            if (!entry.checked) {
              entry.checked = true;
              if (row.status === "failed") entry.fails++;
            }
            lastSeen.set(row.feed_name, entry);
          }
          for (const [name, info] of lastSeen) {
            if (info.fails >= 2) {
              skipFeeds.add(name);
              skipFeed(name);
            }
          }
          if (skipFeeds.size > 0) {
            logger.info(`Conditional RSS: skipping ${skipFeeds.size} consistently failing feeds`);
          }
        }
      } catch {
        // Proceed without conditional skipping
      }
    }

    // ─── Step 1: Collect News ────────────────────
    logger.info("Step 1/4: Collecting news from RSS feeds...");
    const { articles, feedStatuses } = await collectArticles(skipFeeds);

    // ─── Emit feed metrics & check for errors ────
    for (const f of feedStatuses) {
      emitFeedFetch(f.name, f.url, f.status, f.articlesFetched, f.response_time_ms || 0, false, 0, f.error);
      if (f.status === "failed" && f.error) {
        emitError("rss", "warn", `Feed "${f.name}" failed: ${f.error}`, undefined,
          "The feed may be temporarily unreachable — retry mechanism will handle it on next run");
      }
    }

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
      return false;
    }

    // ─── Step 1b: SEC Filing Collection ──────────────
    logger.info("Step 1b: Collecting recent SEC filings...");
    let secExtracts: SECFinancialExtract[] = [];
    try {
      const secResult = await collectSECFilings();
      if (secResult.newFilings.length > 0) {
        logger.info(`SEC: ${secResult.newFilings.length} new filings found, analyzing top ones...`);
        const topFilings = getTopFilings(secResult.newFilings, 5);
        const secAnalysis = await analyzeSECFilings(topFilings, 3);
        secExtracts = secAnalysis.extracts;
        logger.info(`SEC analysis: ${secExtracts.length} filings analyzed (${secExtracts.filter(e => e.impactScore >= 7).length} high-impact)`);

        // Trigger alert system for high-impact SEC filings
        const highImpact = secExtracts.filter((e) => e.impactScore >= 8);
        if (highImpact.length > 0) {
          logger.info(`SEC alerts: ${highImpact.length} high-impact filings detected, sending alerts...`);
          for (const h of highImpact) {
            emitError("sec_filing", "warn",
              `${h.companyName} (${h.ticker}) filed ${h.formType}: ${h.impactRationale}`,
              undefined, `Review the SEC filing at the SEC EDGAR website for details.`);
          }
        }
      } else {
        logger.info("SEC: No new filings found");
      }
    } catch (secError) {
      logger.warn(`SEC collection failed: ${(secError as Error).message}`);
      emitError("sec", "error", `SEC filing collection failed: ${(secError as Error).message}`,
        undefined, "SEC API may be rate-limiting or temporarily unavailable.");
    }

    // ─── Step 1c: Deduplicate ───────────────────
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
    let digest;
    try {
      digest = await processArticles(articlesToProcess);
    } catch (error) {
      const errMsg = (error as Error).message;
      emitError("ai", "error", errMsg, undefined,
        "Check AI API key, rate limits, or model availability. If using Groq, verify your quota at console.groq.com");
      throw error;
    }

    // ─── Alert System: send instant alerts for high-impact articles ──
    if (supabase.isConfigured()) {
      await sendHighImpactAlerts(digest.articles);
    }

    // ─── Step 2b: Fetch Stock Prices ────────────
    const allTickers = [
      ...new Set([
        ...digest.articles.flatMap((a) => a.affectedStocks),
        ...digest.topStocks.map((s) => s.ticker),
      ]),
    ];
    let stockPrices: Map<string, import("./utils/stocks").StockPrice>;
    try {
      const startStock = Date.now();
      stockPrices = await fetchStockPrices(allTickers);
      emitStockFetch(allTickers.length, stockPrices.size, Date.now() - startStock);
    } catch (error) {
      const errMsg = (error as Error).message;
      emitStockFetch(allTickers.length, 0, 0, [errMsg]);
      emitError("yahoo_finance", "error", errMsg, undefined,
        "Yahoo Finance may be rate-limiting. Try again in a few minutes, or check if tickers are valid.");
      stockPrices = new Map();
    }

    // ─── Step 3: Format Digest ───────────────────
    logger.info("Step 3/4: Formatting digest for Telegram...");
    const formattedMessage = formatDigestTelegram(digest, {
      stockPrices,
      secExtracts: secExtracts.length > 0 ? secExtracts : undefined,
    });

    // ─── Step 4: Send to Telegram ───────────────
    logger.info("Step 4/4: Sending digest to Telegram...");
    let sendResult;
    if (targetChatId) {
      // Per-user delivery — send to the target user
      sendResult = await sendDigestMessageToUser(targetChatId, formattedMessage);
      // Log to user_delivery_log
      if (supabase.isConfigured()) {
        await supabase.logUserDelivery(
          targetChatId,
          runDate,
          sendResult.success ? "success" : "failed",
          sendResult.error
        );
      }
    } else {
      sendResult = await sendDigestMessage(formattedMessage);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // ─── Emit delivery metric ────────────────────
    emitDigestDelivery(
      sendResult.success ? "success" : "failed",
      digest.articles.length,
      stockPrices.size,
      parseFloat(elapsed),
      digest.usage.totalTokens,
      sendResult.error
    );

    if (sendResult.success) {
      logger.info(
        `✅ Digest delivered successfully in ${elapsed}s — ` +
          `${digest.articles.length} articles, ${stockPrices.size} prices, ${digest.topStocks.length} stocks`
      );
    } else {
      emitError("telegram", "error", `Digest delivery failed: ${sendResult.error}`);
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
        batches_run: digest.batchesRun,
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
      const secFilingCount = secExtracts.length;

      // Estimate cost based on provider pricing
      const costPer1KTokens = 0.00015; // Groq Llama pricing ~$0.15/1M tokens
      const estimatedCost = digest.usage.totalTokens * costPer1KTokens / 1000;

      // Extract capex tracking from SEC filings
      const grossCapex = secExtracts.reduce((sum, e) => sum + (e.capex || 0), 0);
      const totalAiRev = secExtracts.reduce((sum, e) => sum + (e.aiRevenue || 0), 0);

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
        sec_filings_processed: secFilingCount,
        sec_capex_total: grossCapex > 0 ? grossCapex : undefined,
        sec_ai_revenue_total: totalAiRev > 0 ? totalAiRev : undefined,
      });

      logger.info("✅ Metrics written to Supabase");
    }

    // ─── Write Trending Now ──────────────────────
    if (supabase.isConfigured() && digestRunId) {
      await computeAndStoreTrending(runDate, digest);
    }

    logger.info("✅ Digest pipeline completed successfully");
    return true;

  } catch (error) {
    const errMsg = (error as Error).message;
    logger.error("Digest generation failed", {
      error: errMsg,
      stack: (error as Error).stack?.slice(0, 500),
    });

    // Emit error metric
    emitError("ai", "error", errMsg, undefined,
      "Check the logs for details. Common causes: AI API outage, Supabase connectivity, or network issues.");

    // Record failure in Supabase
    if (supabase.isConfigured()) {
      try {
        const ok = await supabase.createDigestRun({
          run_date: runDate,
          status: "failed",
          articles_collected: 0,
          articles_processed: 0,
          batches_run: 0,
          ai_provider: "groq",
          ai_model: "llama-3.3-70b-versatile",
          total_tokens_used: 0,
          duration_seconds: ((Date.now() - startTime) / 1000),
          error_message: errMsg,
        });
        if (!ok) {
          emitError("supabase", "error", "Failed to create digest run record in Supabase");
        }
      } catch (supaError) {
        emitError("supabase", "error", `Supabase write failed: ${(supaError as Error).message}`,
          undefined, "Check your Supabase credentials and network connectivity.");
      }
    }

    // Try to send error notification
    try {
      await sendDigestMessage(
        `⚠️ <b>AI Infra Digest — Error</b>\n\n` +
          `The daily digest failed to generate:\n<code>${errMsg}</code>\n\n` +
          `Check the GitHub Actions logs for details.`
      );
    } catch {
      // Ignore send errors
    }

    return false;
  }
}

async function main() {
  logger.info("🚀 AI Infrastructure Daily Digest — Starting");

  // Start interactive bot (registers /start, /help, etc.)
  startInteractiveBot();

  const success = await runPipeline();

  // Exit cleanly so the polling loop doesn't keep the process alive in CI
  if (success) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

// ─── High-Impact Alert System ─────────────────────────

/** Send instant alerts for articles with impactScore >= 8 to opted-in users. */
async function sendHighImpactAlerts(articles: import("./processor/ai").ProcessedArticle[]): Promise<void> {
  const { default: TelegramBot } = await import("node-telegram-bot-api");
  const bot = new TelegramBot(config.telegram.botToken, { polling: false });

  const highImpact = articles.filter((a) => a.impactScore >= 8);
  if (highImpact.length === 0) return;

  const users = await supabase.getAllActiveUsers();
  const optedIn = users.filter((u) => u.alerts_enabled);
  if (optedIn.length === 0) {
    logger.info(`Alert system: ${highImpact.length} high-impact articles found, but no users opted in`);
    return;
  }

  logger.info(`Alert system: ${highImpact.length} high-impact articles for ${optedIn.length} users`);

  for (const article of highImpact.slice(0, 5)) {
    const emoji = article.impact === "Bullish" ? "🟢" : article.impact === "Bearish" ? "🔴" : "⚪";
    const text =
      `🚨 <b>HIGH IMPACT ALERT</b>\n\n` +
      `${emoji} <b>${escapeHtml(article.title)}</b>\n` +
      `Impact: ${article.impact} (${article.impactScore}/10)\n` +
      `Sector: ${article.category}\n` +
      `Stocks: ${article.affectedStocks.slice(0, 5).join(", ") || "N/A"}\n\n` +
      `📝 ${escapeHtml(article.summary.split("\\n")[0] || article.summary.slice(0, 200))}\n\n` +
      `${article.url ? `<a href="${article.url}">Read full article</a>` : ""}`;

    for (const user of optedIn) {
      try {
        const minScore = user.alerts_min_score ?? 8;
        if (article.impactScore < minScore) continue;
        await bot.sendMessage(user.chat_id, text, { parse_mode: "HTML", disable_web_page_preview: true });
        logger.info(`Alert sent for article "${article.title.slice(0, 60)}..." to user ${user.chat_id}`);
      } catch {
        // Ignore per-user send errors
      }
    }
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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

    const cfg = getSupabaseConfig();
    if (!cfg) return "Database not available.";

    try {
      const resp = await fetch(
        `${cfg.url}/rest/v1/articles?order=created_at.desc&limit=30&select=title,url,source,impact,impact_score,category,affected_stocks,summary`,
        { headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` } }
      );
      if (!resp.ok) return "Could not fetch articles.";
      let articles = (await resp.json()) as Record<string, unknown>[];

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

  // ─── /alert command ──
  registerCommand("alert", async (ctx) => {
    const parts = ctx.text.split(/\s+/).slice(1);
    const setting = parts[0]?.toLowerCase();

    if (setting === "on") {
      if (!supabase.isConfigured()) {
        return "Supabase not configured. Alert preferences require a database.";
      }
      const ok = await supabase.upsertUserPreferences({
        chat_id: ctx.chatId,
        alerts_enabled: true,
      });
      if (ok) {
        return "🚨 <b>Alerts Enabled</b>\n\nYou'll now receive instant notifications for high-impact articles (score 8+).\n\nUse <code>/alert threshold 9</code> to change the minimum score.\nUse <code>/alert off</code> to disable.";
      }
      return "Could not save alert preference.";
    }

    if (setting === "off") {
      if (!supabase.isConfigured()) {
        return "Supabase not configured.";
      }
      const ok = await supabase.upsertUserPreferences({
        chat_id: ctx.chatId,
        alerts_enabled: false,
      });
      return ok
        ? "🔕 Alerts disabled. You won't receive instant notifications."
        : "Could not save alert preference.";
    }

    if (setting === "threshold") {
      const val = parseInt(parts[1], 10);
      if (isNaN(val) || val < 1 || val > 10) {
        return "Threshold must be a number between 1 and 10.\n\nUsage: <code>/alert threshold 9</code>";
      }
      if (!supabase.isConfigured()) return "Supabase not configured.";
      const ok = await supabase.upsertUserPreferences({
        chat_id: ctx.chatId,
        alerts_min_score: val,
      });
      return ok
        ? `✅ Alert threshold set to <b>${val}/10</b>. Only articles scoring ${val}+ will trigger alerts.`
        : "Could not save threshold.";
    }

    // Show status
    if (!supabase.isConfigured()) {
      return "Supabase not configured. Alerts require a database.\n\n<b>Commands:</b>\n• <code>/alert on</code> — Enable high-impact alerts\n• <code>/alert off</code> — Disable alerts";
    }
    const prefs = await supabase.getUserPreferences(ctx.chatId);
    const status = prefs?.alerts_enabled ? "✅ Enabled" : "❌ Disabled";
    const threshold = prefs?.alerts_min_score ?? 8;
    return (
      `🚨 <b>Alert Settings</b>\n\n` +
      `Status: ${status}\n` +
      `Threshold: ${threshold}/10\n\n` +
      `<b>Commands:</b>\n` +
      `• <code>/alert on</code> — Enable alerts\n` +
      `• <code>/alert off</code> — Disable alerts\n` +
      `• <code>/alert threshold 9</code> — Set minimum impact score`
    );
  });

  // ─── /trending command ──
  registerCommand("trending", async (ctx) => {
    if (!supabase.isConfigured()) {
      return "Supabase not configured. Run the digest first to see trends.";
    }

    const cfg = getSupabaseConfig();
    if (!cfg) return "Database not available.";

    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
      const resp = await fetch(
        `${cfg.url}/rest/v1/daily_metrics?select=date,trending_json,trending_entities&date=gte.${sevenDaysAgo}&order=date.desc`,
        { headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` } }
      );
      if (!resp.ok) return "Could not fetch trending data.";

      const metrics = (await resp.json()) as Record<string, unknown>[];
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

  // ─── /sec command — latest SEC filings ──
  registerCommand("sec", async (ctx) => {
    if (!supabase.isConfigured()) {
      return "Supabase not configured. Run the daily digest to start SEC filing analysis.";
    }

    const cfg = getSupabaseConfig();
    if (!cfg) return "Database not available.";

    const parts = ctx.text.split(/\s+/).slice(1);
    const ticker = parts[0]?.toUpperCase();

    try {
      let url: string;
      if (ticker) {
        // Show filings for a specific ticker
        url = `${cfg.url}/rest/v1/sec_filings?ticker=eq.${ticker}&order=filing_date.desc&limit=5&select=*`;
      } else {
        // Show latest filings across all companies
        url = `${cfg.url}/rest/v1/sec_filings?order=filing_date.desc&limit=8&select=*`;
      }

      const resp = await fetch(url, {
        headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
      });
      if (!resp.ok) return "Could not fetch SEC filings.";

      const filings = (await resp.json()) as Record<string, unknown>[];
      if (!filings.length) {
        return ticker
          ? `No SEC filings found for <b>${ticker}</b>. Run the daily digest to populate filing data.`
          : "No SEC filings yet. Run the daily digest to start filing analysis.";
      }

      const lines: string[] = [];

      if (ticker) {
        lines.push(`📜 <b>SEC Filings — ${ticker}</b>`);
      } else {
        lines.push(`📜 <b>Latest SEC Filings</b>`);
      }
      lines.push("");

      for (const f of filings) {
        const formType = f.form_type as string;
        const company = f.company_name as string;
        const filingDate = f.filing_date as string;
        const impactScore = (f.impact_score as number) || 0;

        const impactEmoji = impactScore >= 8 ? "🔴" : impactScore >= 6 ? "🟡" : "⚪";
        const formEmoji = formType === "8-K" ? "⚡" : formType === "10-Q" ? "📊" : formType === "10-K" ? "📋" : "📄";

        lines.push(`${formEmoji} <b>${escapeHtml(company)}</b> — ${formType}`);
        lines.push(`   Date: ${filingDate} ${impactEmoji} Impact: ${impactScore}/10`);

        const data: string[] = [];
        if (f.capex !== null && f.capex !== undefined) data.push(`💰 Capex: $${(f.capex as number).toLocaleString()}M`);
        if (f.capex_guidance !== null && f.capex_guidance !== undefined) data.push(`📊 Capex Guide: $${(f.capex_guidance as number).toLocaleString()}M`);
        if (f.ai_revenue !== null && f.ai_revenue !== undefined) {
          const growth = f.ai_revenue_growth_pct ? ` (${(f.ai_revenue_growth_pct as number) >= 0 ? "+" : ""}${f.ai_revenue_growth_pct}%)` : "";
          data.push(`🤖 AI Rev: $${(f.ai_revenue as number).toLocaleString()}M${growth}`);
        }
        if (f.gross_margin !== null && f.gross_margin !== undefined) data.push(`📈 GM: ${f.gross_margin}%`);
        if (f.operating_margin !== null && f.operating_margin !== undefined) data.push(`📉 OM: ${f.operating_margin}%`);
        if (f.revenue_guidance !== null && f.revenue_guidance !== undefined) data.push(`🎯 Rev Guide: $${(f.revenue_guidance as number).toLocaleString()}M`);

        if (data.length > 0) {
          lines.push(`   ${data.join(" · ")}`);
        }

        // Show key takeaways
        const takeaways = f.key_takeaways as string[] | null;
        if (takeaways && takeaways.length > 0) {
          lines.push(`   <i>${escapeHtml(takeaways.slice(0, 2).join(" · "))}</i>`);
        }

        lines.push("");
      }

      lines.push("<i>Use /sec TICKER to filter by company (e.g., /sec NVDA)</i>");
      return { text: lines.join("\n") };
    } catch {
      return "Could not fetch SEC filings.";
    }
  });

  // ─── /feedback command ──
  registerCommand("feedback", async (ctx) => {
    const parts = ctx.text.split(/\s+/).slice(1);
    const rating = parseInt(parts[0], 10);
    const comment = parts.slice(1).join(" ");

    if (isNaN(rating) || rating < 1 || rating > 5) {
      return (
        `💬 <b>Feedback</b>\n\n` +
        `Help me improve! Rate today's digest from 1 to 5.\n\n` +
        `<b>Usage:</b>\n` +
        `• <code>/feedback 5</code> — Rate 1–5 (required)\n` +
        `• <code>/feedback 4 Great coverage of NVIDIA</code> — Add a comment\n` +
        `• <code>/feedback 2 Too many articles on power sector</code>\n\n` +
        `<i>Your feedback is anonymous and helps improve the digest.</i>`
      );
    }

    if (!supabase.isConfigured()) {
      return `✅ Thanks for your ${rating}/5 rating! ${comment ? `Comment: "${escapeHtml(comment)}"` : ""}\n\nYour feedback helps improve the digest.`;
    }

    const cfg = getSupabaseConfig();
    if (!cfg) return `✅ Thanks for your ${rating}/5 rating!`;

    try {
      const today = new Date().toISOString().split("T")[0];
      const getResp = await fetch(
        `${cfg.url}/rest/v1/daily_metrics?date=eq.${today}&select=date,feedback_ratings`,
        { headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` } }
      );

      let existingRatings: number[] = [];
      let existingComments: string[] = [];
      if (getResp.ok) {
        const existing = (await getResp.json()) as Record<string, unknown>[];
        if (existing.length > 0 && existing[0].feedback_ratings) {
          try {
            const parsed = JSON.parse(existing[0].feedback_ratings as string) as { ratings: number[]; comments: string[] };
            existingRatings = parsed.ratings || [];
            existingComments = parsed.comments || [];
          } catch { /* start fresh */ }
        }
      }

      existingRatings.push(rating);
      if (comment) existingComments.push(comment);

      await supabase.updateDailyMetrics(today, {
        feedback_ratings: JSON.stringify({ ratings: existingRatings, comments: existingComments }),
      });

      const avg = existingRatings.reduce((s, r) => s + r, 0) / existingRatings.length;
      return `✅ Thanks for your feedback!\n\n` +
        `Your rating: ${rating}/5\n` +
        `${comment ? `Comment: "${escapeHtml(comment)}"\n` : ""}\n` +
        `Average rating today: ${avg.toFixed(1)}/5 (${existingRatings.length} votes)`;
    } catch {
      return `✅ Thanks for your ${rating}/5 rating! (Couldn't save to database, but your feedback is noted.)`;
    }
  });
}

// ─── Trending Now ──────────────────────────────────────

interface TrendingItem {
  entity: string;
  type: "ticker" | "sector" | "company" | "keyword";
  mentionCount: number;
  avgScore: number;
  dominantSentiment: "positive" | "negative" | "neutral";
  topArticles: { title: string; url: string }[];
}

/**
 * Compute trending entities from the current digest and store in Supabase.
 * Averages with the last 7 days of data for a rolling trend view.
 */
async function computeAndStoreTrending(
  runDate: string,
  digest: import("./processor/ai").DigestResult
): Promise<void> {
  try {
    const cfg = getSupabaseConfig();
    if (!cfg) return;

    // Compute trending from current digest
    const tickerCounts = new Map<string, { count: number; totalScore: number; sentiments: number[] }>();
    for (const article of digest.articles) {
      for (const ticker of article.affectedStocks) {
        const entry = tickerCounts.get(ticker) || { count: 0, totalScore: 0, sentiments: [] };
        entry.count++;
        entry.totalScore += article.impactScore;
        entry.sentiments.push(article.impact === "Bullish" ? 1 : article.impact === "Bearish" ? -1 : 0);
        tickerCounts.set(ticker, entry);
      }
    }

    const trending: TrendingItem[] = [];

    // Top tickers by mention count
    const sortedTickers = [...tickerCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5);
    for (const [ticker, data] of sortedTickers) {
      const avgSent = data.sentiments.length > 0
        ? data.sentiments.reduce((s, v) => s + v, 0) / data.sentiments.length
        : 0;
      trending.push({
        entity: ticker,
        type: "ticker",
        mentionCount: data.count,
        avgScore: Math.round((data.totalScore / data.count) * 10) / 10,
        dominantSentiment: avgSent > 0.2 ? "positive" : avgSent < -0.2 ? "negative" : "neutral",
        topArticles: digest.articles
          .filter((a) => a.affectedStocks.includes(ticker))
          .slice(0, 3)
          .map((a) => ({ title: a.title, url: a.url })),
      });
    }

    // Top sectors
    const sectorSorted = Object.entries(digest.categories)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 3);
    for (const [sector, articles] of sectorSorted) {
      const avgScore = articles.reduce((s, a) => s + a.impactScore, 0) / articles.length;
      trending.push({
        entity: sector,
        type: "sector",
        mentionCount: articles.length,
        avgScore: Math.round(avgScore * 10) / 10,
        dominantSentiment: "neutral",
        topArticles: articles.slice(0, 3).map((a) => ({ title: a.title, url: a.url })),
      });
    }

    // Store in daily_metrics under a trending key (Supabase doesn't have a dedicated table)
    await supabase.updateDailyMetrics(runDate, {
      trending_json: JSON.stringify(trending),
      trending_entities: trending.map((t) => t.entity).join(","),
    });

    logger.info(`Trending Now: ${trending.length} entities tracked for ${runDate}`);
  } catch (error) {
    logger.warn(`Trending computation failed: ${(error as Error).message}`);
  }
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
