import OpenAI from "openai";
import { config } from "../config";
import { logger } from "../utils/logger";
import type { Article } from "../collector/rss";

// ─── Types ────────────────────────────────────────────
export interface ProcessedArticle {
  title: string;
  url: string;
  source: string;
  summary: string;
  impact: "Bullish" | "Bearish" | "Neutral";
  impactScore: number;
  affectedStocks: string[];
  reason: string;
}

export interface DigestResult {
  articles: ProcessedArticle[];
  topStocks: { ticker: string; reason: string; sentiment: "positive" | "negative" | "neutral" }[];
  marketOutlook: string;
  summary: string;
}

const BATCH_SIZE = 10;

// ─── AI Client Setup ──────────────────────────────────
function createClient(): OpenAI {
  return new OpenAI({
    apiKey: config.ai.apiKey,
    baseURL: config.ai.baseUrl,
    timeout: 180000,
    maxRetries: 2,
    // Use native fetch instead of node-fetch (fixes gzip decompression on Windows)
    fetch: globalThis.fetch,
  });
}

// ─── Batch Analysis Prompt ────────────────────────────
function buildBatchPrompt(articles: Article[], batchNum: number, totalBatches: number): string {
  return `You are an institutional equity research analyst specializing in AI infrastructure.

Analyze these news articles (batch ${batchNum}/${totalBatches}) and return JSON.

For each article:
1. Summarize in 2-3 bullet points
2. Impact: Bullish, Bearish, or Neutral
3. Affected stocks (tickers like NVDA, AMD, AVGO, MSFT, AMZN, GOOGL, META)
4. Impact score 1-10
5. Why investors should care

Articles:
${articles
  .map(
    (a, i) =>
      `[${i + 1}] ${a.title}
Source: ${a.source}
URL: ${a.url}
Content: ${a.contentSnippet.slice(0, 300)}
---`
  )
  .join("\n\n")}

Respond ONLY with JSON:
{
  "articles": [
    {
      "title": "...",
      "url": "...",
      "source": "...",
      "summary": "• Point 1\\n• Point 2",
      "impact": "Bullish",
      "impactScore": 8,
      "affectedStocks": ["NVDA"],
      "reason": "Why it matters"
    }
  ]
}`;
}

// ─── Synthesis Prompt ────────────────────────────────
function buildSynthesisPrompt(
  batchResults: ProcessedArticle[]
): string {
  const articlesText = batchResults
    .map(
      (a, i) =>
        `[${i + 1}] "${a.title}" — ${a.impact} (${a.impactScore}/10) — Stocks: ${a.affectedStocks.join(", ") || "N/A"}`
    )
    .join("\n");

  return `Based on these analyzed articles, produce a market overview.

Analyzed Articles:
${articlesText}

Respond with JSON:
{
  "topStocks": [
    { "ticker": "NVDA", "reason": "Key driver", "sentiment": "positive" }
  ],
  "marketOutlook": "1-2 sentence outlook on AI infra",
  "summary": "One sentence summary of today's news"
}`;
}

// ─── Parse JSON from AI Response ─────────────────────
function parseJSON<T>(text: string): T | null {
  let cleaned = text.trim();
  const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) cleaned = codeBlock[1].trim();
  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objectMatch) cleaned = objectMatch[0];
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

// ─── Call AI with Retry ──────────────────────────────
async function callAI(client: OpenAI, prompt: string): Promise<string> {
  const response = await client.chat.completions.create({
    model: config.ai.model,
    messages: [
      {
        role: "system",
        content: "You are an equity research AI. Always respond with valid JSON only.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.3,
    max_tokens: 2048,
    ...(config.ai.provider !== "custom"
      ? { response_format: { type: "json_object" as const } }
      : {}),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Empty AI response");
  return content;
}

// ─── Process Articles in Batches ─────────────────────
async function processBatch(
  client: OpenAI,
  batch: Article[],
  batchNum: number,
  totalBatches: number
): Promise<ProcessedArticle[]> {
  const prompt = buildBatchPrompt(batch, batchNum, totalBatches);
  const content = await callAI(client, prompt);
  const result = parseJSON<{ articles: ProcessedArticle[] }>(content);

  if (!result?.articles) {
    logger.warn(`Batch ${batchNum} returned unparseable result, retrying...`);
    // Retry once
    const retryContent = await callAI(client, prompt);
    const retryResult = parseJSON<{ articles: ProcessedArticle[] }>(retryContent);
    if (!retryResult?.articles) {
      logger.error(`Batch ${batchNum} failed after retry`);
      return [];
    }
    return retryResult.articles;
  }

  return result.articles;
}

// ─── Main Processing ──────────────────────────────────
export async function processArticles(
  articles: Article[]
): Promise<DigestResult> {
  logger.info(
    `Processing ${articles.length} articles with ${config.ai.provider} AI ` +
      `(batch size: ${BATCH_SIZE})...`
  );

  const client = createClient();

  // Split into batches
  const batches: Article[][] = [];
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    batches.push(articles.slice(i, i + BATCH_SIZE));
  }

  logger.info(`Split into ${batches.length} batches`);

  // Process all batches
  const allBatchResults: ProcessedArticle[] = [];
  for (let i = 0; i < batches.length; i++) {
    logger.info(`Processing batch ${i + 1}/${batches.length} (${batches[i].length} articles)...`);
    try {
      const batchResults = await processBatch(client, batches[i], i + 1, batches.length);
      allBatchResults.push(...batchResults);
      logger.info(`Batch ${i + 1}: ${batchResults.length} articles analyzed`);
    } catch (error) {
      logger.error(`Batch ${i + 1} failed`, { error: (error as Error).message });
      // Continue with remaining batches
    }
  }

  if (allBatchResults.length === 0) {
    throw new Error("All AI batches failed — no articles could be analyzed");
  }

  // Synthesis pass: create market overview from all results
  logger.info("Running synthesis pass for market outlook...");
  let topStocks: DigestResult["topStocks"] = [];
  let marketOutlook = "AI infrastructure spending remains a key focus in the market.";
  let summary = "Daily digest of AI infrastructure news.";

  try {
    const synthesisPrompt = buildSynthesisPrompt(allBatchResults);
    const synthesisContent = await callAI(client, synthesisPrompt);
    const synthesis = parseJSON<{
      topStocks: DigestResult["topStocks"];
      marketOutlook: string;
      summary: string;
    }>(synthesisContent);

    if (synthesis) {
      topStocks = synthesis.topStocks || [];
      marketOutlook = synthesis.marketOutlook || marketOutlook;
      summary = synthesis.summary || summary;
    }
  } catch (error) {
    logger.warn("Synthesis pass failed, using defaults", {
      error: (error as Error).message,
    });
  }

  logger.info(
    `AI processing complete: ${allBatchResults.length} articles analyzed across ${batches.length} batches`
  );

  return {
    articles: allBatchResults,
    topStocks,
    marketOutlook,
    summary,
  };
}
