import OpenAI from "openai";
import { config } from "../config";
import { logger } from "../utils/logger";
import type { Article } from "../collector/rss";

// ─── AI Infrastructure News Categories ───────────────
export const NEWS_CATEGORIES = [
  "Chips & GPUs",
  "Cloud & Hyperscalers",
  "Datacenters",
  "Networking",
  "Power & Utilities",
  "Cooling Infrastructure",
  "AI Models & Labs",
  "Semiconductor Manufacturing",
  "M&A and Partnerships",
  "Earnings & Guidance",
] as const;

export type NewsCategory = typeof NEWS_CATEGORIES[number];

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
  category: NewsCategory;
}

export interface AIUsage {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
}

export interface DigestResult {
  articles: ProcessedArticle[];
  topStocks: { ticker: string; reason: string; sentiment: "positive" | "negative" | "neutral" }[];
  marketOutlook: string;
  summary: string;
  categories: Record<NewsCategory, ProcessedArticle[]>;
  usage: AIUsage;
}

const BATCH_SIZE = 10;
const CATEGORIES_LIST = NEWS_CATEGORIES.map((c, i) => `${i + 1}. ${c}`).join("\n");

// ─── AI Client Setup ──────────────────────────────────
function createClient(): OpenAI {
  return new OpenAI({
    apiKey: config.ai.apiKey,
    baseURL: config.ai.baseUrl,
    timeout: 180000,
    maxRetries: 2,
    fetch: globalThis.fetch,
  });
}

// ─── Build Category Map ──────────────────────────────
function buildCategoriesMap(articles: ProcessedArticle[]): Record<string, ProcessedArticle[]> {
  const map: Record<string, ProcessedArticle[]> = {};
  for (const cat of NEWS_CATEGORIES) {
    map[cat] = [];
  }
  for (const article of articles) {
    const cat = article.category || NEWS_CATEGORIES[0];
    if (map[cat]) {
      map[cat].push(article);
    } else {
      map[NEWS_CATEGORIES[0]].push(article);
    }
  }
  return map;
}

// ─── Batch Analysis Prompt ────────────────────────────
function buildBatchPrompt(articles: Article[], batchNum: number, totalBatches: number): string {
  return `You are an institutional equity research analyst specializing in AI infrastructure.

Analyze these news articles (batch ${batchNum}/${totalBatches}) and return JSON.

For each article:
1. Summarize in 2-3 bullet points
2. Impact: Bullish, Bearish, or Neutral
3. Affected stocks (tickers like NVDA, AMD, AVGO, MSFT, AMZN, GOOGL, META, TSM, ASML, ANET, VRT, CEG)
4. Impact score 1-10
5. Why investors should care
6. Category — assign ONE best-fit category:
${CATEGORIES_LIST}

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
      "reason": "Why it matters",
      "category": "Chips & GPUs"
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
        `[${i + 1}] "${a.title}" — ${a.impact} (${a.impactScore}/10) — Cats: ${a.category || "Uncategorized"} — Stocks: ${a.affectedStocks.join(", ") || "N/A"}`
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

export interface CallAIResult {
  content: string;
  usage: {
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
  };
}

// ─── Call AI with Retry ──────────────────────────────
async function callAI(client: OpenAI, prompt: string): Promise<CallAIResult> {
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

  const usage = response.usage;
  return {
    content,
    usage: {
      totalTokens: usage?.total_tokens ?? 0,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
    },
  };
}

interface BatchResult {
  articles: ProcessedArticle[];
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
}

// ─── Process Articles in Batches ─────────────────────
async function processBatch(
  client: OpenAI,
  batch: Article[],
  batchNum: number,
  totalBatches: number
): Promise<BatchResult> {
  const prompt = buildBatchPrompt(batch, batchNum, totalBatches);
  const { content, usage } = await callAI(client, prompt);
  const result = parseJSON<{ articles: ProcessedArticle[] }>(content);

  if (!result?.articles) {
    logger.warn(`Batch ${batchNum} returned unparseable result, retrying...`);
    const retryResult = await callAI(client, prompt);
    const retryContent = retryResult.content;
    const retryParsed = parseJSON<{ articles: ProcessedArticle[] }>(retryContent);
    if (!retryParsed?.articles) {
      logger.error(`Batch ${batchNum} failed after retry`);
      return { articles: [], totalTokens: 0, promptTokens: 0, completionTokens: 0 };
    }
    return {
      articles: retryParsed.articles,
      totalTokens: retryResult.usage.totalTokens + usage.totalTokens,
      promptTokens: retryResult.usage.promptTokens + usage.promptTokens,
      completionTokens: retryResult.usage.completionTokens + usage.completionTokens,
    };
  }

  return {
    articles: result.articles,
    totalTokens: usage.totalTokens,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
  };
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
  let totalTokens = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  for (let i = 0; i < batches.length; i++) {
    logger.info(`Processing batch ${i + 1}/${batches.length} (${batches[i].length} articles)...`);
    try {
      const result = await processBatch(client, batches[i], i + 1, batches.length);
      allBatchResults.push(...result.articles);
      totalTokens += result.totalTokens;
      totalPromptTokens += result.promptTokens;
      totalCompletionTokens += result.completionTokens;
      logger.info(`Batch ${i + 1}: ${result.articles.length} articles, ${result.totalTokens} tokens`);
    } catch (error) {
      logger.error(`Batch ${i + 1} failed`, { error: (error as Error).message });
    }
  }

  if (allBatchResults.length === 0) {
    throw new Error("All AI batches failed — no articles could be analyzed");
  }

  // Build categories map
  const categories = buildCategoriesMap(allBatchResults);

  // Synthesis pass: create market overview
  logger.info("Running synthesis pass for market outlook...");
  let topStocks: DigestResult["topStocks"] = [];
  let marketOutlook = "AI infrastructure spending remains a key focus across all sectors.";
  let summary = "Daily digest of AI infrastructure news covering the full value chain.";

  try {
    const synthesisPrompt = buildSynthesisPrompt(allBatchResults);
    const synthesisResult = await callAI(client, synthesisPrompt);
    totalTokens += synthesisResult.usage.totalTokens;
    totalPromptTokens += synthesisResult.usage.promptTokens;
    totalCompletionTokens += synthesisResult.usage.completionTokens;
    const synthesis = parseJSON<{
      topStocks: DigestResult["topStocks"];
      marketOutlook: string;
      summary: string;
    }>(synthesisResult.content);

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

  const categoriesWithContent = Object.fromEntries(
    Object.entries(categories).filter(([, arts]) => arts.length > 0)
  ) as Record<NewsCategory, ProcessedArticle[]>;

  logger.info(
    `AI processing complete: ${allBatchResults.length} articles across ${Object.keys(categoriesWithContent).length} categories (${totalTokens} tokens used)`
  );

  return {
    articles: allBatchResults,
    topStocks,
    marketOutlook,
    summary,
    categories: categoriesWithContent,
    usage: {
      totalTokens,
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
    },
  };
}
