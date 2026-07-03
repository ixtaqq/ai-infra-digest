import { config } from "./config";
import { logger } from "./utils/logger";
import { collectArticles, skipFeed, resetSkippedFeeds, DEAD_FEED_THRESHOLD } from "./collector/rss";
import { processArticles, NEWS_CATEGORIES, isSECFilingArticle } from "./processor/ai";
import { formatDigestTelegram } from "./formatter/telegram";
import {
  sendDigestMessage,
  sendDigestMessageToUser,
  sendValidationFollowUp,
  startInteractiveBot,
  registerCommand,
} from "./sender/telegram";
import type { SendResult } from "./sender/telegram";
import { sendSlackDigest } from "./sender/slack";
import { sendEmailDigest } from "./sender/email";
import { deduplicateArticles } from "./utils/dedup";
import { fetchStockPrices } from "./utils/stocks";
import { supabase } from "./utils/supabase";
import type { UserPreferencesData } from "./utils/supabase";
import {
  emitFeedFetch,
  emitStockFetch,
  emitDigestDelivery,
  emitError,
} from "./utils/metrics";
import { collectSECFilings, getTopFilings } from "./collector/sec";
import { analyzeSECFilings } from "./processor/sec";
import { collectEarningsTranscripts } from "./collector/earnings";
import { analyzeEarningsTranscripts } from "./processor/earnings";
import { withRetry, tryStage } from "./utils/retry";
import { getRolling30DaySpend, isMonthlyBudgetExceeded } from "./utils/budget";
import { getCached, setCached } from "./utils/ai-cache";
import { writeDerivedMetrics, queryRecentDerivedMetrics, queryDerivedMetrics } from "./utils/derived-metrics";
import { getTrustScores } from "./utils/trust-scores";
import { getSourceCredibility, isPRWireSource } from "./utils/source-credibility";
import { buildCorroborationMap } from "./utils/dedup";
import { generateBearCases } from "./processor/bear-cases";
import type { DeepDiveResult } from "./processor/bear-cases";
import { attachGroundingNotes } from "./utils/grounding";
import { flagRehashes } from "./utils/novelty";
import { generateEmbeddings } from "./processor/embeddings";
import { embedSeeds, passesSemanticGate } from "./processor/relevance";
import type { Article, FeedResult } from "./collector/rss";
import type { SECFinancialExtract } from "./processor/sec";
import type { EarningsAnalysis } from "./processor/earnings";

const MAX_ARTICLES_FOR_AI = 35;

/**
 * Bundle produced by {@link generateDigest} and consumed by {@link deliverDigest}
 * and {@link persistDigestMetrics}. Generating once and reusing this bundle lets a
 * single pipeline run be fanned out to many users without recomputing anything.
 */
export interface GeneratedDigest {
  runDate: string;
  startTime: number;
  formattedMessage: string;
  digest: import("./processor/ai").DigestResult;
  articlesCollected: number;
  feedStatuses: FeedResult[];
  secExtracts: SECFinancialExtract[];
  earningsAnalyses: import("./processor/earnings").EarningsAnalysis[];
  stockPrices: Map<string, import("./utils/stocks").StockPrice>;
  /** WoW delta summary injected into the digest header; undefined if <7 days history */
  whatChanged?: string;
  /** Full bull/bear/context thesis for the top article (v9.2). */
  deepDive?: DeepDiveResult;
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
  const runDate = new Date().toISOString().split("T")[0];

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
    const articleUrls = articlesToProcess.map((a) => a.url).filter(Boolean);
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

    // ─── Alert System: send instant alerts for high-impact articles ──
    if (supabase.isConfigured()) {
      await sendHighImpactAlerts(digest.articles);
    }

    // ─── Step 2a0: Relevance Filter (v7.0) ───────────────────────────────────
    const beforeFilter = digest.articles.length;
    digest.articles = digest.articles.filter(
      (a) => (a.relevanceScore ?? 10) >= 4
    );
    const dropped = beforeFilter - digest.articles.length;
    if (dropped > 0) {
      logger.info(`Relevance filter: dropped ${dropped} low-relevance articles (< 4/10)`);
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
      // v8.1: rebuild corroboration map with semantic similarity now that embeddings exist
      corroborationMap = buildCorroborationMap(articlesToProcess, embeddingsStage.value);
      logger.info("Corroboration map rebuilt with semantic (cosine) similarity");
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
        emitError("earnings", "error", `Earnings stage failed: ${earningsStage.error}`, undefined,
          "Roic.ai API may be rate-limiting or temporarily unavailable.");
      }
    } else {
      logger.info("Step 2b: Skipping earnings transcript mining (ROIC_AI_API_KEY not configured)");
    }

    // ─── Step 2c: Fetch Stock Prices ────────────
    const allTickers = [
      ...new Set([
        ...digest.articles.flatMap((a) => a.affectedStocks),
        ...digest.topStocks.map((s) => s.ticker),
      ]),
    ];
    const startStock = Date.now();
    const stockStage = await tryStage(
      () => fetchStockPrices(allTickers),
      "stock prices"
    );
    let stockPrices: Map<string, import("./utils/stocks").StockPrice>;
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
      const cb = 1 + (rawCount - 1) * 0.05;                       // +5% per extra source
      const noveltyMultiplier = article.isRehash ? 0.6 : 1.0;
      article.effectiveScore = article.impactScore * sm * sc * cm * cb * noveltyMultiplier;
      if (isPRWireSource(article.source)) {
        article.effectiveScore = Math.min(article.effectiveScore, 6);
      }
    }

    // Re-sort by effectiveScore so trust-boosted articles surface first
    digest.articles.sort(
      (a, b) => (b.effectiveScore ?? b.impactScore) - (a.effectiveScore ?? a.impactScore)
    );

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
          ai_provider: "groq",
          ai_model: config.ai.model,
          ai_fast_model: config.ai.fastModel,
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

    return null;
  }
}

/**
 * Query last 8 days of derived metrics and compute WoW deltas.
 * Returns a 2–4 line "Market Pulse" string, or undefined if <7 days of data.
 */
async function buildWhatChanged(): Promise<string | undefined> {
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
    if (uniqueDates.length < 7) return undefined;

    const movers: { entity: string; entityType: string; pct: number; direction: "up" | "down" }[] = [];

    for (const [key, entityRows] of byEntity) {
      if (entityRows.length < 2) continue;
      const today = entityRows[entityRows.length - 1];
      const weekAgo = entityRows[Math.max(0, entityRows.length - 8)];
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

function buildPersonalizationNote(prefs: UserPreferencesData): string {
  const parts: string[] = [];
  const watchlist = prefs.watchlist ?? [];
  const cats = prefs.categories_enabled ?? [];
  const minScore = prefs.min_impact_score ?? 0;
  if (watchlist.length > 0) parts.push(`watchlist: ${watchlist.join(", ")}`);
  if (cats.length > 0) parts.push(`sectors: ${cats.join(", ")}`);
  if (minScore > 0) parts.push(`min score: ${minScore}/10`);
  if ((prefs.digest_length ?? "standard") !== "standard") parts.push(`${prefs.digest_length} digest`);
  return parts.length > 0 ? `Filtered for you — ${parts.join(" · ")}` : "";
}

/**
 * Filter a DigestResult to match a user's preferences. Returns a new DigestResult
 * with articles filtered by min_impact_score and categories_enabled, and watchlist
 * tickers boosted to the front of articles and topStocks.
 */
export function applyUserFilter(
  digest: import("./processor/ai").DigestResult,
  prefs: UserPreferencesData
): import("./processor/ai").DigestResult {
  let articles = digest.articles;

  const minScore = prefs.min_impact_score ?? 0;
  if (minScore > 0) {
    articles = articles.filter((a) => a.impactScore >= minScore);
  }

  const enabledCats = prefs.categories_enabled ?? [];
  if (enabledCats.length > 0) {
    articles = articles.filter((a) => enabledCats.includes(a.category));
  }

  const watchlist = (prefs.watchlist ?? []).map((t) => t.toUpperCase());
  let topStocks = digest.topStocks;
  if (watchlist.length > 0) {
    // Watchlist tickers float to the top of stocks and articles
    const inWatch = (tickers: string[]) =>
      tickers.some((t) => watchlist.includes(t.toUpperCase()));
    const watchlistStocks = topStocks.filter((s) => watchlist.includes(s.ticker.toUpperCase()));
    const otherStocks = topStocks.filter((s) => !watchlist.includes(s.ticker.toUpperCase()));
    topStocks = [...watchlistStocks, ...otherStocks].slice(0, 5);

    const watchlistArticles = articles.filter((a) => inWatch(a.affectedStocks));
    const otherArticles = articles.filter((a) => !inWatch(a.affectedStocks));
    articles = [...watchlistArticles, ...otherArticles];
  }

  // Rebuild category map from filtered articles
  const categories = {} as import("./processor/ai").DigestResult["categories"];
  for (const cat of NEWS_CATEGORIES) {
    categories[cat as import("./processor/ai").NewsCategory] = [];
  }
  for (const article of articles) {
    const cat = (article.category || NEWS_CATEGORIES[0]) as import("./processor/ai").NewsCategory;
    if (categories[cat]) categories[cat].push(article);
  }

  // Trim summaries to match digest_length preference
  const length = prefs.digest_length ?? "standard";
  if (length !== "standard") {
    articles = articles.map((a) => ({
      ...a,
      summary: trimSummary(a.summary, length),
      reason: length === "brief" ? "" : a.reason,
    }));
  }

  return { ...digest, articles, topStocks, categories };
}

const SUMMARY_LIMITS: Record<string, number> = { brief: 80, standard: 999, detailed: 999 };

function trimSummary(text: string, length: string): string {
  const limit = SUMMARY_LIMITS[length] ?? 999;
  if (!text || text.length <= limit) return text;
  return text.slice(0, limit).replace(/\s+\S*$/, "") + "…";
}

/**
 * Deliver an already-generated digest to a single target (or the default chat
 * when no `targetChatId` is given). When `userPrefs` are provided and contain
 * any personalization (watchlist, category filter, or min score), the digest is
 * re-formatted from raw data for that user instead of sending the shared message.
 * Cheap — safe to call many times for one {@link GeneratedDigest}.
 */
export async function deliverDigest(
  generated: GeneratedDigest,
  targetChatId?: number,
  userPrefs?: UserPreferencesData
): Promise<SendResult> {
  const { runDate, digest, stockPrices, startTime, secExtracts, earningsAnalyses } = generated;

  const isPersonalized =
    userPrefs &&
    ((userPrefs.min_impact_score ?? 0) > 0 ||
      (userPrefs.categories_enabled?.length ?? 0) > 0 ||
      (userPrefs.watchlist?.length ?? 0) > 0 ||
      (userPrefs.digest_length ?? "standard") !== "standard");

  const messageToSend = isPersonalized
    ? formatDigestTelegram(applyUserFilter(digest, userPrefs!), {
        stockPrices,
        secExtracts: secExtracts.length > 0 ? secExtracts : undefined,
        earningsAnalyses: earningsAnalyses.length > 0 ? earningsAnalyses : undefined,
        personalizationNote: buildPersonalizationNote(userPrefs!),
        whatChanged: generated.whatChanged,
      })
    : generated.formattedMessage;

  logger.info(
    targetChatId
      ? `Delivering digest to user ${targetChatId}${isPersonalized ? " (personalized)" : ""}...`
      : "Sending digest to default chat..."
  );

  let sendResult: SendResult;
  if (targetChatId) {
    sendResult = await sendDigestMessageToUser(targetChatId, messageToSend);
    if (supabase.isConfigured()) {
      await supabase.logUserDelivery(
        targetChatId,
        runDate,
        sendResult.success ? "success" : "failed",
        sendResult.error
      );
    }
  } else {
    sendResult = await sendDigestMessage(messageToSend);
  }

  // Fire Slack + email in parallel (optional channels, failures are non-fatal)
  if (!targetChatId) {
    logger.info(`Additional channels — Slack: ${config.app.slackWebhookUrl ? "configured" : "not set"}, Email: ${config.app.smtpUser ? "configured" : "not set"}`);
    await Promise.allSettled([
      config.app.slackWebhookUrl ? sendSlackDigest(messageToSend) : Promise.resolve(false),
      config.app.smtpUser && config.app.digestEmailTo ? sendEmailDigest(messageToSend) : Promise.resolve(false),
    ]);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
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
      `✅ Digest delivered in ${elapsed}s — ` +
        `${digest.articles.length} articles, ${stockPrices.size} prices, ${digest.topStocks.length} stocks`
    );
  } else {
    emitError("telegram", "error", `Digest delivery failed: ${sendResult.error}`);
    logger.error("Failed to deliver digest", { error: sendResult.error });
  }

  return sendResult;
}

/**
 * Persist run metrics for a generated digest to Supabase (digest_runs, articles,
 * sector activity, stock mentions/prices, daily metrics, trending). Call ONCE per
 * generation, after delivery — not once per user.
 */
export async function persistDigestMetrics(
  generated: GeneratedDigest,
  status: "success" | "failed",
  errorMessage?: string
): Promise<Map<string, number>> {
  if (!supabase.isConfigured()) return new Map();

  const { runDate, startTime, digest, articlesCollected, feedStatuses, secExtracts, stockPrices } = generated;
  const durationSeconds = Math.round(((Date.now() - startTime) / 1000) * 10) / 10;

  logger.info("Writing metrics to Supabase...");

  const allTickers = [
    ...new Set([
      ...digest.articles.flatMap((a) => a.affectedStocks),
      ...digest.topStocks.map((s) => s.ticker),
    ]),
  ];

  const digestRunId = await supabase.createDigestRun({
    run_date: runDate,
    status,
    articles_collected: articlesCollected,
    articles_processed: digest.articles.length,
    batches_run: digest.batchesRun,
    ai_provider: "groq",
    ai_model: config.ai.model,
    ai_fast_model: config.ai.fastModel,
    total_tokens_used: digest.usage.totalTokens,
    duration_seconds: durationSeconds,
    error_message: status === "success" ? undefined : errorMessage,
  });

  // Build url→id map from article insert; used by validation follow-up buttons
  let articleIds: Map<string, number> = new Map();

  if (digestRunId) {
    const inserted = await supabase.insertArticles(
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
        is_sec_filing: a.isSECFiling || undefined,
        bear_case: a.bearCase,
        embedding: a.embedding,
      }))
    );
    articleIds = new Map(inserted.filter(r => r.url).map(r => [r.url, r.id]));

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

  const costPer1KTokens = 0.00015; // Groq Llama pricing ~$0.15/1M tokens
  const estimatedCost = digest.usage.totalTokens * costPer1KTokens / 1000;

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
    digest_status: status,
    sec_filings_processed: secFilingCount,
    sec_capex_total: grossCapex > 0 ? grossCapex : undefined,
    sec_ai_revenue_total: totalAiRev > 0 ? totalAiRev : undefined,
  });

  if (digestRunId) {
    await computeAndStoreTrending(runDate, digest);
  }

  // ── Budget cap alerts ───────────────────────────────────────────────────
  await checkBudget(runDate, estimatedCost);

  logger.info("✅ Metrics written to Supabase");
  return articleIds;
}

async function checkBudget(runDate: string, todayCost: number): Promise<void> {
  const { budgetDailyUsd, budgetMonthlyUsd } = config.app;
  const alerts: string[] = [];

  if (todayCost >= budgetDailyUsd) {
    alerts.push(
      `⚠️ <b>AI Cost Alert — Daily budget hit</b>\n` +
        `Today's run cost: <b>$${todayCost.toFixed(4)}</b>\n` +
        `Daily cap: $${budgetDailyUsd.toFixed(2)}\n\n` +
        `<i>Adjust <code>AI_BUDGET_DAILY_USD</code> or review token usage.</i>`
    );
  }

  // Check rolling 30-day spend from daily_metrics (includes today's just-recorded cost)
  const monthlyTotal = (await getRolling30DaySpend()) + todayCost;
  if (monthlyTotal >= budgetMonthlyUsd) {
    alerts.push(
      `⚠️ <b>AI Cost Alert — Monthly budget hit</b>\n` +
        `30-day spend: <b>$${monthlyTotal.toFixed(4)}</b>\n` +
        `Monthly cap: $${budgetMonthlyUsd.toFixed(2)}\n\n` +
        `<i>Adjust <code>AI_BUDGET_MONTHLY_USD</code> or review token usage. Next run will be skipped until spend drops below the cap.</i>`
    );
  }

  for (const alert of alerts) {
    logger.warn(`Budget alert: ${alert.replace(/<[^>]+>/g, "")}`);
    await sendDigestMessage(alert).catch(() => {});
  }
}

/**
 * Run the full pipeline for a single delivery target — generate, deliver, persist.
 * Used by the daily workflow (no target → default chat). For multi-user fan-out,
 * call {@link generateDigest} once and {@link deliverDigest} per user instead.
 *
 * Returns true on successful delivery.
 */
export async function runPipeline(targetChatId?: number): Promise<boolean> {
  const generated = await generateDigest();
  if (!generated) return false;

  const sendResult = await deliverDigest(generated, targetChatId);
  const articleIds = await persistDigestMetrics(
    generated,
    sendResult.success ? "success" : "failed",
    sendResult.error
  );

  if (sendResult.success && articleIds.size > 0) {
    const chatId = targetChatId ?? (config.telegram.chatId ? Number(config.telegram.chatId) : undefined);
    if (chatId) {
      try {
        await sendValidationFollowUp(chatId, generated.digest.articles, articleIds);
      } catch {
        // Non-critical — digest already delivered
      }
    }
  }

  logger.info("✅ Digest pipeline completed");
  return sendResult.success;
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
        await bot.sendMessage(user.chat_id, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
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

  // ─── /trends command — time-series sparkline + WoW delta ──
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

  // ─── /sources quality command — trust multiplier table ──
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

  // ─── /sec command — latest SEC filings ──
  registerCommand("sec", async (ctx) => {
    if (!supabase.isConfigured()) {
      return "Supabase not configured. Run the daily digest to start SEC filing analysis.";
    }

    const parts = ctx.text.split(/\s+/).slice(1);
    const ticker = parts[0]?.toUpperCase();

    try {
      const params = ticker
        ? `ticker=eq.${encodeURIComponent(ticker)}&order=filing_date.desc&limit=5&select=*`
        : "order=filing_date.desc&limit=8&select=*";
      const filings = await supabase.queryRows<Record<string, unknown>>("sec_filings", params);
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

    try {
      const today = new Date().toISOString().split("T")[0];
      const existing = await supabase.queryRows<Record<string, unknown>>(
        "daily_metrics",
        `date=eq.${encodeURIComponent(today)}&select=date,feedback_ratings`
      );

      let existingRatings: number[] = [];
      let existingComments: string[] = [];
      if (existing.length > 0 && existing[0].feedback_ratings) {
        try {
          const parsed = JSON.parse(existing[0].feedback_ratings as string) as { ratings: number[]; comments: string[] };
          existingRatings = parsed.ratings || [];
          existingComments = parsed.comments || [];
        } catch { /* start fresh */ }
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
    if (!supabase.isConfigured()) return;

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

if (require.main === module) {
  registerDigestCommands();
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

export { main };
export type { FeedResult };
