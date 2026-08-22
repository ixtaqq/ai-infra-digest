import { config } from "../config";
import { NEWS_CATEGORIES } from "../processor/ai";
import {
  AI_ANALYSIS_SCHEMA_VERSION,
  AI_PROMPT_VERSION,
} from "../processor/versions";
import type { DigestResult } from "../processor/ai";
import {
  assessSignalQuality,
  evaluateSignalQuality,
} from "../evaluation/signal-quality";
import { sendDigestMessage } from "../sender/telegram";
import { getRolling30DaySpend } from "../utils/budget";
import { degradedCapabilities } from "../utils/capabilities";
import { logger } from "../utils/logger";
import { supabase } from "../utils/supabase";
import type { GeneratedDigest } from "./types";
import type { TrendingItem } from "./trending";

const SEC_FORM_TYPES = new Set(["8-K", "10-K", "10-Q", "10-K/A", "10-Q/A", "8-K/A"]);

interface SecFilingRow {
  date: string;
  ticker: string;
  company_name: string;
  form_type: string;
  filing_date: string;
  accession_number: string;
  primary_document_url: string | null;
  items: string[];
  capex: number | null;
  capex_guidance: number | null;
  capex_source: string | null;
  ai_revenue: number | null;
  ai_revenue_growth_pct: number | null;
  ai_revenue_source: string | null;
  gross_margin: number | null;
  operating_margin: number | null;
  margin_source: string | null;
  inventory: number | null;
  inventory_turnover: number | null;
  inventory_source: string | null;
  revenue_guidance: number | null;
  eps_guidance: number | null;
  guidance_text: string | null;
  impact_score: number | null;
  impact_rationale: string | null;
  key_takeaways: string[];
}

function nullableFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeImpactScore(value: unknown): number | null {
  const score = nullableFiniteNumber(value);
  return score === null ? null : Math.min(10, Math.max(1, Math.round(score)));
}

function normalizeSecExtract(runDate: string, extract: GeneratedDigest["secExtracts"][number]): SecFilingRow | null {
  const ticker = nullableText(extract.ticker);
  const companyName = nullableText(extract.companyName);
  const formType = nullableText(extract.formType);
  const filingDate = nullableText(extract.filingDate);
  const accessionNumber = nullableText(extract.accessionNumber);

  if (
    !ticker ||
    !companyName ||
    !formType ||
    !SEC_FORM_TYPES.has(formType) ||
    !filingDate ||
    !accessionNumber
  ) {
    return null;
  }

  return {
    date: runDate,
    ticker,
    company_name: companyName,
    form_type: formType,
    filing_date: filingDate,
    accession_number: accessionNumber,
    primary_document_url: nullableText(extract.primaryDocumentUrl),
    items: stringArray(extract.items),
    capex: nullableFiniteNumber(extract.capex),
    capex_guidance: nullableFiniteNumber(extract.capexGuidance),
    capex_source: nullableText(extract.capexSource),
    ai_revenue: nullableFiniteNumber(extract.aiRevenue),
    ai_revenue_growth_pct: nullableFiniteNumber(extract.aiRevenueGrowthPct),
    ai_revenue_source: nullableText(extract.aiRevenueSource),
    gross_margin: nullableFiniteNumber(extract.grossMargin),
    operating_margin: nullableFiniteNumber(extract.operatingMargin),
    margin_source: nullableText(extract.marginSource),
    inventory: nullableFiniteNumber(extract.inventory),
    inventory_turnover: nullableFiniteNumber(extract.inventoryTurnover),
    inventory_source: nullableText(extract.inventorySource),
    revenue_guidance: nullableFiniteNumber(extract.revenueGuidance),
    eps_guidance: nullableFiniteNumber(extract.epsGuidance),
    guidance_text: nullableText(extract.guidanceText),
    impact_score: normalizeImpactScore(extract.impactScore),
    impact_rationale: nullableText(extract.impactRationale),
    key_takeaways: stringArray(extract.keyTakeaways),
  };
}

export async function persistSecFilings(
  runDate: string,
  secExtracts: GeneratedDigest["secExtracts"]
): Promise<void> {
  if (!supabase.isConfigured() || secExtracts.length === 0) return;

  const rowsByKey = new Map<string, SecFilingRow>();
  for (const extract of secExtracts) {
    const row = normalizeSecExtract(runDate, extract);
    if (row) rowsByKey.set(`${row.ticker}:${row.accession_number}`, row);
  }
  const rows = [...rowsByKey.values()];
  if (rows.length === 0) return;

  const url = config.app.supabaseUrl;
  const key = config.app.supabaseServiceKey;
  if (!url || !key) return;

  try {
    const response = await fetch(
      `${url}/rest/v1/sec_filings?on_conflict=ticker,accession_number`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: key,
          Authorization: `Bearer ${key}`,
          Prefer: "return=minimal,resolution=merge-duplicates",
        },
        body: JSON.stringify(rows),
      }
    );
    if (!response.ok && response.status !== 201) {
      logger.warn(`Supabase sec_filings upsert: ${response.status}`);
      return;
    }
    logger.info(`Supabase: stored ${rows.length} SEC filing extracts`);
  } catch (error) {
    logger.warn(`Supabase sec_filings upsert: ${(error as Error).message}`);
  }
}

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
      ...digest.articles.flatMap((article) => article.affectedStocks),
      ...digest.topStocks.map((stock) => stock.ticker),
    ]),
  ];

  const qualityMetrics = evaluateSignalQuality(digest);
  const qualityAssessment = assessSignalQuality(qualityMetrics);
  if (!qualityAssessment.passed) {
    logger.warn(`Signal quality baseline: ${qualityAssessment.issues.join("; ")}`);
  }

  const digestRunId = await supabase.createDigestRun({
    run_date: runDate,
    status,
    articles_collected: articlesCollected,
    articles_processed: digest.articles.length,
    batches_run: digest.batchesRun,
    ai_provider: config.ai.provider,
    ai_model: config.ai.model,
    ai_fast_model: config.ai.fastModel,
    total_tokens_used: digest.usage.totalTokens,
    duration_seconds: durationSeconds,
    error_message: status === "success" ? undefined : errorMessage,
    capabilities: generated.capabilities,
    degraded_stages: degradedCapabilities(generated.capabilities),
    prompt_version: AI_PROMPT_VERSION,
    analysis_schema_version: AI_ANALYSIS_SCHEMA_VERSION,
    quality_metrics: { ...qualityMetrics, baselinePassed: qualityAssessment.passed },
  });

  let articleIds = new Map<string, number>();
  if (digestRunId) {
    const inserted = await supabase.insertArticles(
      digestRunId,
      digest.articles.map((article) => ({
        title: article.title,
        url: article.url,
        source: article.source,
        impact: article.impact,
        impact_score: article.impactScore,
        category: article.category,
        affected_stocks: article.affectedStocks,
        summary: article.summary,
        reason: article.reason,
        is_sec_filing: article.isSECFiling || undefined,
        bear_case: article.bearCase,
        embedding: article.embedding,
        corroboration_count: article.corroborationCount,
        grounding_text: article.groundingNote,
        effective_score: article.effectiveScore,
        ranking_explanation: article.rankingExplanation,
        source_identity_verified: article.sourceIdentityVerified,
      }))
    );
    articleIds = new Map(inserted.filter((row) => row.url).map((row) => [row.url, row.id]));

    await supabase.insertPipelineHealth(
      digestRunId,
      feedStatuses.map((feed) => ({
        feed_name: feed.name,
        feed_url: feed.url,
        status: feed.status,
        articles_fetched: feed.articlesFetched,
        error_message: feed.error,
      }))
    );
  }

  const sectorCounts: Record<
    string,
    { count: number; totalScore: number; bullish: number; bearish: number; neutral: number }
  > = {};
  for (const article of digest.articles) {
    const category = article.category || NEWS_CATEGORIES[0];
    if (!sectorCounts[category]) {
      sectorCounts[category] = { count: 0, totalScore: 0, bullish: 0, bearish: 0, neutral: 0 };
    }
    sectorCounts[category].count++;
    sectorCounts[category].totalScore += article.impactScore;
    if (article.impact === "Bullish") sectorCounts[category].bullish++;
    else if (article.impact === "Bearish") sectorCounts[category].bearish++;
    else sectorCounts[category].neutral++;
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

  const mentionMap: Record<string, { count: number; totalSentiment: number; totalScore: number }> = {};
  for (const article of digest.articles) {
    for (const ticker of article.affectedStocks) {
      if (!mentionMap[ticker]) mentionMap[ticker] = { count: 0, totalSentiment: 0, totalScore: 0 };
      mentionMap[ticker].count++;
      mentionMap[ticker].totalSentiment +=
        article.impact === "Bullish" ? 1 : article.impact === "Bearish" ? -1 : 0;
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

  await supabase.insertStockPrices(
    [...stockPrices.values()].map((price) => ({
      date: runDate,
      ticker: price.ticker,
      price: Math.round(price.price * 100) / 100,
      change: Math.round(price.change * 100) / 100,
      change_percent: Math.round(price.changePercent * 100) / 100,
      previous_close: Math.round(price.previousClose * 100) / 100,
    }))
  );

  await persistSecFilings(runDate, secExtracts);

  const healthyFeeds = feedStatuses.filter((feed) => feed.status === "success").length;
  const failingFeeds = feedStatuses.filter((feed) => feed.status === "failed").length;
  const costPer1KTokens = 0.00015;
  const estimatedCost = digest.usage.totalTokens * costPer1KTokens / 1000;
  const grossCapex = secExtracts.reduce((sum, extract) => sum + (extract.capex || 0), 0);
  const totalAiRevenue = secExtracts.reduce((sum, extract) => sum + (extract.aiRevenue || 0), 0);

  await supabase.updateDailyMetrics(runDate, {
    total_articles_processed: digest.articles.length,
    total_stocks_tracked: allTickers.length,
    sectors_active: Object.keys(digest.categories).length,
    feeds_healthy: healthyFeeds,
    feeds_failing: failingFeeds,
    total_tokens_used: digest.usage.totalTokens,
    estimated_cost: Math.round(estimatedCost * 1000000) / 1000000,
    top_sector: Object.entries(sectorCounts).sort((a, b) => b[1].count - a[1].count)[0]?.[0] || null,
    top_ticker: Object.entries(mentionMap).sort((a, b) => b[1].count - a[1].count)[0]?.[0] || null,
    digest_status: status,
    sec_filings_processed: secExtracts.length,
    sec_capex_total: grossCapex > 0 ? grossCapex : undefined,
    sec_ai_revenue_total: totalAiRevenue > 0 ? totalAiRevenue : undefined,
  });

  if (digestRunId) await computeAndStoreTrending(runDate, digest);
  await checkBudget(estimatedCost);
  logger.info("✅ Metrics written to Supabase");
  return articleIds;
}

async function checkBudget(todayCost: number): Promise<void> {
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

async function computeAndStoreTrending(runDate: string, digest: DigestResult): Promise<void> {
  try {
    if (!supabase.isConfigured()) return;
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
    for (const [ticker, data] of [...tickerCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)) {
      const averageSentiment = data.sentiments.length > 0
        ? data.sentiments.reduce((sum, value) => sum + value, 0) / data.sentiments.length
        : 0;
      trending.push({
        entity: ticker,
        type: "ticker",
        mentionCount: data.count,
        avgScore: Math.round((data.totalScore / data.count) * 10) / 10,
        dominantSentiment: averageSentiment > 0.2 ? "positive" : averageSentiment < -0.2 ? "negative" : "neutral",
        topArticles: digest.articles
          .filter((article) => article.affectedStocks.includes(ticker))
          .slice(0, 3)
          .map((article) => ({ title: article.title, url: article.url })),
      });
    }

    for (const [sector, articles] of Object.entries(digest.categories)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 3)) {
      const averageScore = articles.reduce((sum, article) => sum + article.impactScore, 0) / articles.length;
      trending.push({
        entity: sector,
        type: "sector",
        mentionCount: articles.length,
        avgScore: Math.round(averageScore * 10) / 10,
        dominantSentiment: "neutral",
        topArticles: articles.slice(0, 3).map((article) => ({ title: article.title, url: article.url })),
      });
    }

    await supabase.updateDailyMetrics(runDate, {
      trending_json: JSON.stringify(trending),
      trending_entities: trending.map((item) => item.entity).join(","),
    });
    logger.info(`Trending Now: ${trending.length} entities tracked for ${runDate}`);
  } catch (error) {
    logger.warn(`Trending computation failed: ${(error as Error).message}`);
  }
}
