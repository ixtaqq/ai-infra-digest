import { createHash } from "crypto";
import { config } from "../config";
import { collectEarningsTranscripts } from "../collector/earnings";
import { collectArticles, DEAD_FEED_THRESHOLD, resetSkippedFeeds, skipFeed } from "../collector/rss";
import type { Article, FeedResult } from "../collector/rss";
import { collectSECFilings, getTopFilings } from "../collector/sec";
import { formatDigestTelegram } from "../formatter/telegram";
import { isSECFilingArticle, NEWS_CATEGORIES, processArticles } from "../processor/ai";
import { generateBearCases } from "../processor/bear-cases";
import { analyzeEarningsTranscripts } from "../processor/earnings";
import type { EarningsAnalysis } from "../processor/earnings";
import { generateEmbeddings } from "../processor/embeddings";
import { embedSeeds, passesSemanticGate } from "../processor/relevance";
import { analyzeSECFilings } from "../processor/sec";
import type { SECFinancialExtract } from "../processor/sec";
import { sendDigestMessage } from "../sender/telegram";
import { getCached, setCached } from "../utils/ai-cache";
import { isMonthlyBudgetExceeded } from "../utils/budget";
import {
  degradedCapabilities,
  formatCapabilityReport,
  getCapabilityReport,
} from "../utils/capabilities";
import { buildCorroborationMap, deduplicateArticles } from "../utils/dedup";
import { queryRecentDerivedMetrics, writeDerivedMetrics } from "../utils/derived-metrics";
import { escapeHtml } from "../utils/escape";
import { findConsistentlyFailingFeeds } from "../utils/feed-health";
import { attachGroundingNotes } from "../utils/grounding";
import { todayInTimezone } from "../utils/helpers";
import { logger } from "../utils/logger";
import { emitError, emitFeedFetch, emitStockFetch } from "../utils/metrics";
import { flagRehashes } from "../utils/novelty";
import { calculateRanking } from "../utils/ranking";
import { tryStage, withRetry } from "../utils/retry";
import { getSourceCredibility, isPRWireSource } from "../utils/source-credibility";
import { fetchStockPrices } from "../utils/stocks";
import { supabase } from "../utils/supabase";
import { getTrustScores } from "../utils/trust-scores";
import type { GeneratedDigest } from "./types";

const MIN_ALERT_SCORE = 8;
const MIN_RELEVANCE_SCORE = 4;
const ALERT_SCORE_MIN = 1;
const ALERT_SCORE_MAX = 10;

function clampAlertScore(value: unknown, fallback: number): number {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : Number.NaN;

  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(ALERT_SCORE_MAX, Math.max(ALERT_SCORE_MIN, numeric));
}

function escapeAlertText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return escapeHtml(value.slice(0, maxLength));
}

function safeAlertUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return "";
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return escapeHtml(value.trim().slice(0, 2048));
  } catch {
    return "";
  }
}

function alertContentHash(article: import("../processor/ai").ProcessedArticle): string {
  const identity = [article.url, article.title, article.source]
    .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
    .join("\n");
  return createHash("sha256").update(identity).digest("hex");
}

function normalizedImpact(value: unknown): "Bullish" | "Bearish" | "Neutral" {
  return value === "Bullish" || value === "Bearish" || value === "Neutral"
    ? value
    : "Neutral";
}

/**
 * Generate the daily digest ONCE — collect, dedup, AI process, SEC, earnings,
 * stock prices, and format. Fires high-impact and SEC alerts. Does NOT send or
 * persist; callers deliver + persist separately so one generation can serve many
 * users. Returns the bundle, or null if nothing could be produced (no articles,
 * or a generation error — in which case a failed run is recorded and an alert sent).
 */
export async function generateDigest(): Promise<GeneratedDigest | null> {
  const startTime = Date.now();
  const runDate = todayInTimezone(config.app.timezone);
  const maxArticlesForAI = config.app.maxArticlesForAI;
  const capabilities = getCapabilityReport(config);
  logger.info(`Capabilities: ${formatCapabilityReport(capabilities)}`);

  try {
    // ─── Pre-spend budget gate: block the run if the 30-day cap is already hit ──
    if (await isMonthlyBudgetExceeded()) {
      logger.warn(`AI budget gate: 30-day spend cap ($${config.app.budgetMonthlyUsd.toFixed(2)}) already reached — skipping run for ${runDate}`);
      await sendDigestMessage(
        `⚠️ <b>AI Infra Digest — Run Skipped</b>\n\n` +
          `The 30-day AI budget cap (<b>$${config.app.budgetMonthlyUsd.toFixed(2)}</b>) has already been reached, ` +
          `so today's digest was not generated to avoid further spend.\n\n` +
          `<i>Raise <code>AI_BUDGET_MONTHLY_USD</code> or wait for the rolling window to clear.</i>`
      );
      return null;
    }

    // ─── Conditional RSS: skip consistently failing feeds ──
    // Start each run from a clean slate — in the long-lived webhook process the
    // module-level SKIPPED_FEEDS set would otherwise only ever grow across runs.
    resetSkippedFeeds();
    const skipFeeds = new Set<string>();
    if (supabase.isConfigured()) {
      const data = await supabase.queryRows<{ feed_name: string; status: string }>(
        "pipeline_health",
        "select=feed_name,status&order=created_at.desc&limit=200"
      );
      // Count consecutive failures per feed
      for (const name of findConsistentlyFailingFeeds(data, 2)) {
        skipFeeds.add(name);
        skipFeed(name);
      }
      if (skipFeeds.size > 0) {
        logger.info(`Conditional RSS: skipping ${skipFeeds.size} consistently failing feeds`);
      }
    }

    // ─── Step 1: Collect News ────────────────────
    logger.info("Step 1/4: Collecting news from RSS feeds...");
    const { articles, feedStatuses } = await collectArticles(skipFeeds);

    // ─── Emit feed metrics & check for errors ────
    const deadFeeds: string[] = [];
    for (const f of feedStatuses) {
      emitFeedFetch(f.name, f.url, f.status, f.articlesFetched, f.response_time_ms || 0, false, 0, f.error);
      if (f.status === "failed" && f.error) {
        const isLikelyDead = (f.consecutiveFailures || 0) >= DEAD_FEED_THRESHOLD;
        if (isLikelyDead) deadFeeds.push(f.name);
        emitError(
          "rss",
          "warn",
          `Feed "${f.name}" failed: ${f.error}`,
          undefined,
          isLikelyDead
            ? `Failed ${f.consecutiveFailures} consecutive runs — likely a dead/changed URL, not transient. Update or remove this feed from src/collector/rss.ts.`
            : "The feed may be temporarily unreachable — retry mechanism will handle it on next run"
        );
      }
    }
    if (deadFeeds.length > 0) {
      logger.warn(`${deadFeeds.length} feed(s) appear permanently dead (${DEAD_FEED_THRESHOLD}+ consecutive failures): ${deadFeeds.join(", ")}`);
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
      return null;
    }

    // ─── Step 1b: SEC Filing Collection ──────────────
    logger.info("Step 1b: Collecting recent SEC filings...");
    let secExtracts: SECFinancialExtract[] = [];
    const secStage = await tryStage(async () => {
      const secResult = await collectSECFilings();
      if (secResult.newFilings.length === 0) return [];
      logger.info(`SEC: ${secResult.newFilings.length} new filings found, analyzing top ones...`);
      const topFilings = getTopFilings(secResult.newFilings, 5);
      const secAnalysis = await analyzeSECFilings(topFilings, 5);
      return secAnalysis.extracts;
    }, "SEC collection");
    if (secStage.ok) {
      secExtracts = secStage.value;
      logger.info(`SEC analysis: ${secExtracts.length} filings (${secExtracts.filter(e => e.impactScore >= 7).length} high-impact)`);
      for (const h of secExtracts.filter((e) => e.impactScore >= 8)) {
        emitError("sec_filing", "warn",
          `${h.companyName} (${h.ticker}) filed ${h.formType}: ${h.impactRationale}`,
          undefined, "Review the filing on SEC EDGAR for details.");
      }
    } else {
      emitError("sec", "error", `SEC stage failed: ${secStage.error}`, undefined,
        "SEC API may be rate-limiting or temporarily unavailable.");
    }

    // ─── Step 1c: Deduplicate ───────────────────
    logger.info(`Step 1b: Deduplicating ${articles.length} articles...`);
    // Build corroboration map BEFORE dedup — needs full raw batch to count clusters
    let corroborationMap = buildCorroborationMap(articles);
    const uniqueArticles = await deduplicateArticles(articles);

    let articlesToProcess: Article[];
    if (uniqueArticles.length === 0) {
      logger.info("All articles were duplicates; processing top articles anyway");
      articlesToProcess = articles.slice(0, maxArticlesForAI);
    } else {
      articlesToProcess = uniqueArticles.slice(0, maxArticlesForAI);
    }

    logger.info(
      `Processing ${articlesToProcess.length}/${articles.length} articles ` +
        `(dedup skipped ${articles.length - uniqueArticles.length}, ` +
        `capped at ${maxArticlesForAI})`
    );

    // ─── Step 2: AI Processing ───────────────────
    logger.info(`Step 2/4: Processing articles with AI (${articlesToProcess.length} articles)...`);
    const articleUrls = articlesToProcess.map((a) => JSON.stringify([a.url, a.title, a.source, a.summary, a.contentSnippet]));
    const cached = getCached(articleUrls);
    const digest = cached ?? await withRetry(
      () => processArticles(articlesToProcess),
      {
        maxAttempts: 2,
        baseDelayMs: 5_000,
        label: "AI processing",
        shouldRetry: (err) => !err.message.includes("401") && !err.message.includes("invalid_api_key"),
      }
    ).then((result) => {
      setCached(articleUrls, result);
      return result;
    }).catch((error) => {
      const errMsg = (error as Error).message;
      emitError("ai", "error", errMsg, undefined,
        "Check AI API key, rate limits, or model availability. If using Groq, verify your quota at console.groq.com");
      throw error;
    });

    // ─── Step 2a0: Relevance Filter (v7.0) ───────────────────────────────────
    const beforeFilter = digest.articles.length;
    digest.articles = digest.articles.filter(
      (a) => (a.relevanceScore ?? 10) >= MIN_RELEVANCE_SCORE
    );
    const dropped = beforeFilter - digest.articles.length;
    if (dropped > 0) {
      logger.info(`Relevance filter: dropped ${dropped} low-relevance articles (< 4/10)`);
    }

    // ─── Alert System: send instant alerts after relevance filtering ──
    if (supabase.isConfigured()) {
      await sendHighImpactAlerts(digest.articles);
    }

    // ─── Step 2d: Embeddings (v8.0) ──────────────────────────────────────────
    const embeddingsStage = await tryStage(
      () => generateEmbeddings(digest.articles),
      "embeddings"
    );
    if (embeddingsStage.ok) {
      for (const article of digest.articles) {
        article.embedding = embeddingsStage.value.get(article.url);
      }
      // v8.1: rebuild corroboration map with semantic similarity only when
      // vectors were actually generated. An empty map means lexical fallback.
      if (embeddingsStage.value.size > 0) {
        corroborationMap = buildCorroborationMap(articlesToProcess, embeddingsStage.value);
        logger.info("Corroboration map rebuilt with semantic (cosine) similarity");
      } else {
        logger.info("Embeddings unavailable; retaining lexical corroboration map");
      }

      // Loud degradation: configured but produced zero vectors ⇒ Phase VIII is
      // silently off (almost always an OpenAI quota/429). Emit a structured error
      // so it shows up in metrics/daily summary instead of only stdout.
      if (config.ai.embeddingApiKey && digest.articles.length > 0 && embeddingsStage.value.size === 0) {
        capabilities.embeddings = { state: "degraded", detail: "configured but produced no vectors" };
        emitError(
          "ai",
          "warn",
          `Embeddings degraded: 0/${digest.articles.length} vectors generated for run ${runDate}`,
          429,
          "OPENAI_EMBEDDING_API_KEY likely out of quota/rate-limited. Semantic dedup + relevance gate are disabled this run (fell back to Jaccard). Restore the key's OpenAI quota to re-enable Phase VIII."
        );
      }
    } else if (config.ai.embeddingApiKey) {
      capabilities.embeddings = { state: "degraded", detail: "embedding stage failed" };
    }

    // ─── Step 2e: Semantic Relevance Gate (v8.2) ─────────────────────────────
    const seedsStage = await tryStage(() => embedSeeds(), "seed embeddings");
    if (seedsStage.ok && seedsStage.value.length > 0) {
      const seedEmbeddings = seedsStage.value;
      const beforeGate = digest.articles.length;
      digest.articles = digest.articles.filter((a) => {
        if (!a.embedding) return true; // no embedding → keep (fall back to AI score)
        return passesSemanticGate(a.embedding, seedEmbeddings);
      });
      const gateDropped = beforeGate - digest.articles.length;
      if (gateDropped > 0) {
        logger.info(`Semantic gate: dropped ${gateDropped} off-topic articles (cosine < 0.55)`);
      }
    } else if (!seedsStage.ok && config.ai.embeddingApiKey) {
      capabilities.embeddings = { state: "degraded", detail: "seed embedding stage failed" };
    }

    // ─── Step 2a: Devil's Advocate — Bear Cases + Deep-Dive (v9.2) ─────────────
    const bearCaseStage = await tryStage(
      () => generateBearCases(digest.articles),
      "bear cases"
    );
    const bearCaseResult = bearCaseStage.ok
      ? bearCaseStage.value
      : { bearCases: new Map<string, string>() };
    for (const article of digest.articles) {
      const bc = bearCaseResult.bearCases.get(article.url);
      if (bc) article.bearCase = bc;
    }
    const deepDive = bearCaseResult.deepDive;

    // ─── Step 2a1: Novelty Check (v7.2) ──────────────────────────────────────
    await tryStage(() => flagRehashes(digest.articles), "novelty check");

    // ─── Step 2b: Earnings Transcript Mining ─────
    let earningsAnalyses: EarningsAnalysis[] = [];
    if (config.app.roicAiApiKey) {
      logger.info("Step 2b: Mining earnings call transcripts...");
      const earningsStage = await tryStage(async () => {
        const earningsResult = await collectEarningsTranscripts();
        if (earningsResult.transcripts.length === 0) return [];
        const analysisResult = await analyzeEarningsTranscripts(earningsResult.transcripts);
        return analysisResult.analyses;
      }, "earnings transcripts");
      if (earningsStage.ok) {
        earningsAnalyses = earningsStage.value;
        logger.info(`Earnings analysis: ${earningsAnalyses.length} transcripts analyzed`);
      } else {
        capabilities.earnings = { state: "degraded", detail: "transcript stage failed" };
        emitError("earnings", "error", `Earnings stage failed: ${earningsStage.error}`, undefined,
          "Roic.ai API may be rate-limiting or temporarily unavailable.");
      }
    } else {
      logger.info("Step 2b: Skipping earnings transcript mining (ROIC_AI_API_KEY not configured)");
    }

    // ─── Step 2c: Fetch Stock Prices ────────────
    // Fetched once here (not per-user) — price-watch checks in deliverDigest()
    // filter this same list by chat_id instead of re-querying Supabase per user.
    const activeWatches = supabase.isConfigured() ? await supabase.getAllPriceWatches() : [];
    // Watched tickers go FIRST: fetchStockPrices() caps the list at 25 entries
    // (see utils/stocks.ts), so a watched ticker appended after a busy article
    // day would be silently truncated and its watch would never fire.
    const allTickers = [
      ...new Set([
        ...activeWatches.map((w) => w.ticker),
        ...digest.articles.flatMap((a) => a.affectedStocks),
        ...digest.topStocks.map((s) => s.ticker),
      ]),
    ];
    const startStock = Date.now();
    const stockStage = await tryStage(
      () => fetchStockPrices(allTickers),
      "stock prices"
    );
    let stockPrices: Map<string, import("../utils/stocks").StockPrice>;
    if (stockStage.ok) {
      stockPrices = stockStage.value;
      emitStockFetch(allTickers.length, stockPrices.size, Date.now() - startStock);
    } else {
      stockPrices = new Map();
      emitStockFetch(allTickers.length, 0, 0, [stockStage.error]);
      emitError("yahoo_finance", "error", stockStage.error, undefined,
        "Yahoo Finance may be rate-limiting. Try again in a few minutes.");
    }

    // ─── Tag articles with SEC filing badge ──────
    for (const article of digest.articles) {
      if (isSECFilingArticle(article)) {
        article.isSECFiling = true;
      }
    }
    const flaggedCount = digest.articles.filter((a) => a.isSECFiling).length;
    if (flaggedCount > 0) {
      logger.info(`SEC badge: ${flaggedCount} articles tagged as SEC filings`);
    }

    // ─── Step 3b: Write derived metrics (time-series intelligence layer) ────────
    if (supabase.isConfigured()) {
      await tryStage(
        () => writeDerivedMetrics(digest, runDate, stockPrices),
        "derived metrics"
      );
    }

    // ─── Step 3b.1: Apply trust-weighted effective scores ────────────────────
    const trustScores = supabase.isConfigured()
      ? await getTrustScores().catch(() => ({
          source: new Map<string, number>(),
          sector: new Map<string, number>(),
        }))
      : { source: new Map<string, number>(), sector: new Map<string, number>() };

    for (const article of digest.articles) {
      const sm = trustScores.source.get(article.source) ?? 1.0;   // vote-learned
      const sc = getSourceCredibility(article.source);             // static editorial tier
      const cm = trustScores.sector.get(article.category) ?? 1.0;
      const rawCount = corroborationMap.get(article.url) ?? 1;
      const explanation = calculateRanking({
        impactScore: article.impactScore,
        relevanceScore: article.relevanceScore,
        sourceTrust: sm,
        sourceCredibility: sc,
        sectorTrust: cm,
        corroborationCount: rawCount,
        isRehash: article.isRehash ?? false,
        isPRWire: isPRWireSource(article.source),
      });
      article.corroborationCount = rawCount;
      article.rankingExplanation = explanation;
      article.effectiveScore = explanation.finalScore;
    }

    // Re-sort by effectiveScore so trust-boosted articles surface first
    digest.articles.sort(
      (a, b) => (b.effectiveScore ?? b.impactScore) - (a.effectiveScore ?? a.impactScore)
    );
    for (const articles of Object.values(digest.categories)) {
      articles.sort(
        (a, b) => (b.effectiveScore ?? b.impactScore) - (a.effectiveScore ?? a.impactScore)
      );
    }

    // ─── Step 3a.1: Cross-Source Grounding (v9.1) ────────────────────────────
    attachGroundingNotes(digest.articles, secExtracts, earningsAnalyses, stockPrices);

    // ─── Step 3c: Build "What Changed" WoW summary ───────────────────────────
    const whatChanged = supabase.isConfigured()
      ? await buildWhatChanged()
      : undefined;

    // ─── Step 3: Format Digest ───────────────────
    logger.info("Step 3/4: Formatting digest for Telegram...");
    const formattedMessage = formatDigestTelegram(digest, {
      stockPrices,
      secExtracts: secExtracts.length > 0 ? secExtracts : undefined,
      earningsAnalyses: earningsAnalyses.length > 0 ? earningsAnalyses : undefined,
      whatChanged,
      deepDive,
    });

    logger.info(
      `✅ Digest generated in ${((Date.now() - startTime) / 1000).toFixed(1)}s — ` +
        `${digest.articles.length} articles across ${Object.keys(digest.categories).length} sectors, ${stockPrices.size} prices`
    );

    return {
      runDate,
      startTime,
      formattedMessage,
      digest,
      articlesCollected: articles.length,
      feedStatuses,
      secExtracts,
      earningsAnalyses,
      stockPrices,
      whatChanged,
      deepDive,
      activeWatches,
      capabilities,
    };

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
          ai_provider: config.ai.provider,
          ai_model: config.ai.model,
          ai_fast_model: config.ai.fastModel,
          total_tokens_used: 0,
          duration_seconds: ((Date.now() - startTime) / 1000),
          error_message: errMsg,
          capabilities,
          degraded_stages: degradedCapabilities(capabilities),
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

    return null;
  }
}

/**
 * Query last 8 days of derived metrics and compute WoW deltas.
 * Returns a 2–4 line "Market Pulse" string, or undefined if fewer than 8 days
 * of data are available for a valid current-vs-seven-days-ago comparison.
 */
export async function buildWhatChanged(): Promise<string | undefined> {
  try {
    const rows = await queryRecentDerivedMetrics();
    if (!rows.length) return undefined;

    // Group by entity
    const byEntity = new Map<string, { date: string; mention_count: number; avg_impact_score: number | null }[]>();
    for (const row of rows) {
      const key = `${row.entity_type}:${row.entity}`;
      if (!byEntity.has(key)) byEntity.set(key, []);
      byEntity.get(key)!.push(row as { date: string; mention_count: number; avg_impact_score: number | null });
    }

    // Need at least 7 days of history for a meaningful delta
    const uniqueDates = [...new Set(rows.map((r) => r.date))];
    if (uniqueDates.length < 8) return undefined;

    const movers: { entity: string; entityType: string; pct: number; direction: "up" | "down" }[] = [];

    for (const [key, entityRows] of byEntity) {
      if (entityRows.length < 8) continue;
      const today = entityRows[entityRows.length - 1];
      const weekAgo = entityRows[entityRows.length - 8];
      if (!weekAgo || weekAgo.date === today.date) continue;
      const delta = today.mention_count - weekAgo.mention_count;
      const pct = weekAgo.mention_count > 0 ? (delta / weekAgo.mention_count) * 100 : 0;
      if (Math.abs(pct) >= 20) {
        const [entityType, entity] = key.split(":");
        movers.push({ entity, entityType, pct, direction: pct >= 0 ? "up" : "down" });
      }
    }

    if (!movers.length) return undefined;

    movers.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
    const top = movers.slice(0, 3);

    const lines = ["📊 <b>Market Pulse · WoW</b>"];
    for (const m of top) {
      const arrow = m.direction === "up" ? "📈" : "📉";
      const sign = m.pct >= 0 ? "+" : "";
      const label = m.entityType === "sector" ? m.entity : `<b>${m.entity}</b>`;
      lines.push(`${arrow} ${label} mentions ${sign}${m.pct.toFixed(0)}% WoW`);
    }

    return lines.join("\n");
  } catch {
    return undefined;
  }
}


export async function sendHighImpactAlerts(articles: import("../processor/ai").ProcessedArticle[]): Promise<void> {
  const highImpact = articles
    .map((article) => ({
      article,
      impactScore: clampAlertScore(article.impactScore, ALERT_SCORE_MIN),
    }))
    .filter(({ impactScore }) => impactScore >= MIN_ALERT_SCORE);
  if (highImpact.length === 0) return;

  const users = await supabase.getAllActiveUsers();
  const optedIn = users.filter((u) => u.alerts_enabled === true);
  if (optedIn.length === 0) {
    logger.info(`Alert system: ${highImpact.length} high-impact articles found, but no users opted in`);
    return;
  }

  const { default: TelegramBot } = await import("node-telegram-bot-api");
  const bot = new TelegramBot(config.telegram.botToken, { polling: false });

  logger.info(`Alert system: ${highImpact.length} high-impact articles for ${optedIn.length} users`);

  for (const { article, impactScore } of highImpact.slice(0, 5)) {
    const contentHash = alertContentHash(article);
    const impact = normalizedImpact(article.impact);
    const emoji = impact === "Bullish" ? "🟢" : impact === "Bearish" ? "🔴" : "⚪";
    const title = escapeAlertText(article.title, 300) || "Untitled article";
    const category = escapeAlertText(article.category, 100) || "Uncategorized";
    const stocks = Array.isArray(article.affectedStocks)
      ? article.affectedStocks
          .filter((stock): stock is string => typeof stock === "string")
          .slice(0, 5)
          .map((stock) => escapeAlertText(stock, 30))
          .filter(Boolean)
          .join(", ")
      : "";
    const summary = typeof article.summary === "string"
      ? article.summary.split(/(?:\r\n|\r|\n|\\n)/)[0] || article.summary.slice(0, 200)
      : "";
    const url = safeAlertUrl(article.url);
    const text =
      `🚨 <b>HIGH IMPACT ALERT</b>\n\n` +
      `${emoji} <b>${title}</b>\n` +
      `Impact: ${impact} (${impactScore}/10)\n` +
      `Sector: ${category}\n` +
      `Stocks: ${stocks || "N/A"}\n\n` +
      `📝 ${escapeAlertText(summary.slice(0, 200), 200)}\n\n` +
      `${url ? `<a href="${url}">Read full article</a>` : ""}`;

    for (const user of optedIn) {
      let claimed = false;
      try {
        const minScore = clampAlertScore(user.alerts_min_score, MIN_ALERT_SCORE);
        if (impactScore < minScore || !Number.isSafeInteger(user.chat_id)) continue;
        claimed = await supabase.claimHighImpactAlert(user.chat_id, contentHash);
        if (!claimed) continue;
        await bot.sendMessage(user.chat_id, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
        await supabase.logHighImpactAlert(user.chat_id, contentHash, "success");
        const logTitle = typeof article.title === "string" ? article.title : "untitled";
        logger.info(`Alert sent for article "${logTitle.slice(0, 60)}..." to user ${user.chat_id}`);
      } catch (error) {
        if (claimed) {
          await supabase.logHighImpactAlert(
            user.chat_id,
            contentHash,
            "failed",
            (error as Error).message.slice(0, 300)
          );
        }
      }
    }
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
