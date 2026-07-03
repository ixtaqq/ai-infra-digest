/**
 * SEC Filing AI Processor
 *
 * Takes raw 8-K, 10-K, and 10-Q filing text and uses AI to extract:
 * - Capital Expenditure (Capex) figures and guidance
 * - AI / Data Center segment revenue breakdowns
 * - Gross / Operating Margins
 * - Inventory levels and trends
 * - Forward guidance and outlook statements
 *
 * Designed to cost < $0.02 per filing with Groq Llama pricing.
 */

import OpenAI from "openai";
import { z } from "zod";
import { config } from "../config";
import { logger } from "../utils/logger";
import { sleep } from "../utils/helpers";
import { nullableFinancialNumber } from "../utils/ai-schema";
import type { SECFiling } from "../collector/sec";

// ─── Types ──────────────────────────────────────────────

export interface SECFinancialExtract {
  /** The ticker this filing relates to */
  ticker: string;
  /** Filing form type (8-K, 10-K, 10-Q) */
  formType: string;
  /** Filing date */
  filingDate: string;
  /** Company name */
  companyName: string;

  // ─── Capex ────────────────────────────────────────
  /** Capex this quarter/year (in $M) */
  capex: number | null;
  /** Capex guidance for forward period (in $M) */
  capexGuidance: number | null;
  /** Original text snippet for capex */
  capexSource: string;

  // ─── AI Revenue ───────────────────────────────────
  /** AI / Data Center segment revenue (in $M) */
  aiRevenue: number | null;
  /** YoY growth of AI segment revenue (%) */
  aiRevenueGrowthPct: number | null;
  /** Original text snippet for AI revenue */
  aiRevenueSource: string;

  // ─── Margins ──────────────────────────────────────
  /** Gross margin percentage */
  grossMargin: number | null;
  /** Operating margin percentage */
  operatingMargin: number | null;
  /** Original text snippet for margins */
  marginSource: string;

  // ─── Inventory ────────────────────────────────────
  /** Inventory value (in $M) */
  inventory: number | null;
  /** Inventory days or turnover ratio */
  inventoryTurnover: number | null;
  /** Original text snippet for inventory */
  inventorySource: string;

  // ─── Guidance ─────────────────────────────────────
  /** Revenue guidance for next quarter (in $M) */
  revenueGuidance: number | null;
  /** EPS guidance for next quarter */
  epsGuidance: number | null;
  /** Any qualitative or quantitative forward-looking statement */
  guidanceText: string;

  // ─── Overall ──────────────────────────────────────
  /** 1-10 impact score for this filing on the AI infra thesis */
  impactScore: number;
  /** Brief rationale for the impact score */
  impactRationale: string;
  /** Key takeaways for investors (2-3 bullet points) */
  keyTakeaways: string[];
}

export interface SECAnalysisResult {
  extracts: SECFinancialExtract[];
  /** Total AI tokens used */
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
}

// ─── AI Client ──────────────────────────────────────────

function createClient(): OpenAI {
  return new OpenAI({
    apiKey: config.ai.apiKey,
    baseURL: config.ai.baseUrl,
    timeout: 120000,
    maxRetries: 2,
    fetch: globalThis.fetch,
  });
}

// ─── Keywords for Pre-Filtering ─────────────────────────

/** Keywords that signal relevant financial data in SEC filings.
 * Used to skip irrelevant filings before any AI call. */
const RELEVANT_KEYWORDS = [
  "capital expenditure", "capex",
  "ai revenue", "data center revenue", "ai segment",
  "gross margin", "operating margin", "margin expansion",
  "inventory", "inventory days", "inventory turnover",
  "revenue guidance", "earnings guidance", "eps guidance",
  "forward guidance", "outlook",
  "capital allocation", "share buyback", "dividend",
];

/**
 * Quick keyword pre-filter to skip filings with no relevant financial data.
 * Returns true if the filing text mentions any of the target keywords.
 * This is a free pre-filter before any AI call.
 */
function hasRelevantKeywords(text: string): boolean {
  const lower = text.toLowerCase();
  return RELEVANT_KEYWORDS.some((kw) => lower.includes(kw));
}

// ─── Pass 1: Flagging Prompt ────────────────────────────

function buildFlagPrompt(filing: SECFiling): string {
  return `Does this SEC filing contain concrete financial data relevant to AI infrastructure investing?

Company: ${filing.companyName} (${filing.ticker})
Form: ${filing.formType}
Date: ${filing.filingDate}

Check if it mentions SPECIFIC NUMBERS for any of:
- Capital Expenditure (Capex) or Capex guidance
- AI / Data Center segment revenue
- Gross margins or operating margins
- Inventory levels or turnover
- Revenue or EPS forward guidance

FILING TEXT:
${filing.rawText.slice(0, 3000)}

Respond with JSON only:
{"hasFinancialData": true/false, "reason": "Brief reason for the decision"}`;
}

// ─── Pass 2: Extraction Prompt ──────────────────────────

function buildSECPrompt(filing: SECFiling): string {
  return `You are an institutional equity research analyst specializing in AI infrastructure.

Analyze this SEC filing from ${filing.companyName} (${filing.ticker}) filed on ${filing.filingDate}.
Form type: ${filing.formType}
Items disclosed: ${filing.items.join(", ")}
Description: ${filing.description}

Extract key financial data relevant to the AI infrastructure investment thesis.
Focus specifically on: Capital Expenditure (Capex), AI/Data Center Revenue, Margins, Inventory, and Forward Guidance.

FILING TEXT:
${filing.rawText.slice(0, 12000)}

Return JSON only:
{
  "capex": <number_in_millions_or_null>,
  "capexGuidance": <number_in_millions_or_null>,
  "capexSource": "Exact text snippet proving the capex number",
  "aiRevenue": <number_in_millions_or_null>,
  "aiRevenueGrowthPct": <YoY_growth_percent_or_null>,
  "aiRevenueSource": "Exact text snippet proving the AI revenue number",
  "grossMargin": <percentage_or_null>,
  "operatingMargin": <percentage_or_null>,
  "marginSource": "Exact text snippet proving margin numbers",
  "inventory": <inventory_in_millions_or_null>,
  "inventoryTurnover": <turnover_ratio_or_null>,
  "inventorySource": "Exact text snippet proving inventory numbers",
  "revenueGuidance": <next_quarter_revenue_guidance_in_millions_or_null>,
  "epsGuidance": <next_quarter_EPS_guidance_or_null>,
  "guidanceText": "Full qualitative guidance statements or outlook paragraph",
  "impactScore": <1_to_10_rating>,
  "impactRationale": "Why this filing matters for AI infrastructure investment",
  "keyTakeaways": ["Bullet point 1", "Bullet point 2", "Bullet point 3"]
}`;
}

// ─── Parse JSON ─────────────────────────────────────────

/**
 * Clean JSON from LLM response — strips markdown code fences
 * and extracts the first JSON object or array.
 */
function cleanJSON(text: string): string {
  let cleaned = text.trim();
  const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) cleaned = codeBlock[1].trim();
  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objectMatch) cleaned = objectMatch[0];
  return cleaned;
}

const SECFinancialExtractSchema = z.object({
  capex: nullableFinancialNumber,
  capexGuidance: nullableFinancialNumber,
  capexSource: z.string().catch(""),
  aiRevenue: nullableFinancialNumber,
  aiRevenueGrowthPct: nullableFinancialNumber,
  aiRevenueSource: z.string().catch(""),
  grossMargin: nullableFinancialNumber,
  operatingMargin: nullableFinancialNumber,
  marginSource: z.string().catch(""),
  inventory: nullableFinancialNumber,
  inventoryTurnover: nullableFinancialNumber,
  inventorySource: z.string().catch(""),
  revenueGuidance: nullableFinancialNumber,
  epsGuidance: nullableFinancialNumber,
  guidanceText: z.string().catch(""),
  impactScore: z.coerce.number().catch(5),
  impactRationale: z.string().catch(""),
  keyTakeaways: z.array(z.string()).catch([]),
});

/**
 * Parses + validates the Pass 2 extraction response. Returns null (not a
 * half-populated object) if the AI response isn't even a JSON object — ticker/
 * formType/filingDate/companyName are merged in by the caller afterward.
 */
function parseSECJSON(text: string): SECFinancialExtract | null {
  let raw: unknown;
  try {
    raw = JSON.parse(cleanJSON(text));
  } catch {
    return null;
  }
  const result = SECFinancialExtractSchema.safeParse(raw);
  if (!result.success) return null;
  // ticker/formType/filingDate/companyName are filled in by the caller (processFiling).
  return result.data as SECFinancialExtract;
}

const FlagResponseSchema = z.object({
  hasFinancialData: z.boolean(),
  reason: z.string().catch(""),
});

/** Lightweight parser for the Pass 1 flag response shape. */
function parseFlagResponse(text: string): { hasFinancialData: boolean; reason: string } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(cleanJSON(text));
  } catch {
    return null;
  }
  const result = FlagResponseSchema.safeParse(raw);
  return result.success ? result.data : null;
}

// ─── Call AI with Retry ────────────────────────────────

async function callAI(client: OpenAI, prompt: string, model?: string): Promise<{
  content: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
}> {
  const activeModel = model || config.ai.model;
  let lastError: Error | null = null;
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: activeModel,
        messages: [
          {
            role: "system",
            content:
              "You are an equity research AI specializing in AI infrastructure. " +
              "Extract precise financial data from SEC filings. Return JSON only.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 1024,
        ...(config.ai.provider !== "custom"
          ? { response_format: { type: "json_object" as const } }
          : {}),
      });

      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error("Empty AI response");

      const usage = response.usage;
      return {
        content,
        totalTokens: usage?.total_tokens ?? 0,
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries) {
        logger.warn(`SEC AI call attempt ${attempt + 1}/${maxRetries + 1} failed: ${lastError.message}`);
        const maxDelay = 2000 * Math.pow(2, attempt);
        await sleep(Math.random() * maxDelay);
      }
    }
  }

  throw lastError ?? new Error("SEC AI call failed after all retries");
}

// ─── Process a Single Filing (Pass 2 — uses STRONG model) ──

interface FilingResult {
  extract: SECFinancialExtract | null;
  tokenUsage: { totalTokens: number; promptTokens: number; completionTokens: number };
}

async function processFiling(
  client: OpenAI,
  filing: SECFiling
): Promise<FilingResult> {
  const prompt = buildSECPrompt(filing);
  try {
    // Pass 2 uses the strong model for accurate number extraction
    const result = await callAI(client, prompt, config.ai.model);
    const extract = parseSECJSON(result.content);

    if (!extract) {
      logger.warn(`SEC AI returned unparseable result for ${filing.ticker} ${filing.formType}`);
      return {
        extract: null,
        tokenUsage: {
          totalTokens: result.totalTokens,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
        },
      };
    }

    // Merge metadata from the filing
    extract.ticker = filing.ticker;
    extract.formType = filing.formType;
    extract.filingDate = filing.filingDate;
    extract.companyName = filing.companyName;

    return {
      extract,
      tokenUsage: {
        totalTokens: result.totalTokens,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
      },
    };
  } catch (error) {
    logger.warn(`SEC AI processing failed for ${filing.ticker} ${filing.formType}: ${(error as Error).message}`);
    return {
      extract: null,
      tokenUsage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 },
    };
  }
}

// ─── Pass 1: Flag Filing (uses FAST model) ──────────────

interface FlagResult {
  hasData: boolean;
  reason: string;
}

/**
 * Pass 1: Use the fast/cheap model to flag whether a filing contains
 * relevant financial data (Capex, AI Revenue, Margins, Inventory, Guidance).
 * This is much cheaper than running full extraction on every filing.
 */
async function flagFiling(
  client: OpenAI,
  filing: SECFiling
): Promise<FlagResult> {
  // Step 1a: Free keyword pre-filter — skip if no relevant keywords found
  if (!hasRelevantKeywords(filing.rawText)) {
    return { hasData: false, reason: "No relevant keywords found in filing text" };
  }

  // Step 1b: Fast AI flagging — confirm relevance with context awareness
  const prompt = buildFlagPrompt(filing);
  try {
    const result = await callAI(client, prompt, config.ai.fastModel);
    const parsed = parseFlagResponse(result.content);
    if (parsed) {
      return {
        hasData: parsed.hasFinancialData,
        reason: parsed.reason || (parsed.hasFinancialData ? "Flagged by fast model" : "Skipped by fast model"),
      };
    }
    // If parsing fails, default to flagging (safer to over-include)
    return { hasData: true, reason: "Default flag (parse failure)" };
  } catch (error) {
    logger.warn(`SEC flag failed for ${filing.ticker}: ${(error as Error).message}`);
    // On error, default to flagging (safer to over-include)
    return { hasData: true, reason: "Default flag (error fallback)" };
  }
}

// ─── Main Processing ────────────────────────────────────

/**
 * Two-pass SEC filing analysis:
 *
 * Pass 1 (Fast model): Flag which filings contain relevant financial data.
 *   - Free keyword pre-filter skips filings with no relevant keywords
 *   - Fast AI model (llama-3.1-8b) confirms relevance contextually
 *
 * Pass 2 (Strong model): Extract actual numbers from flagged filings only.
 *   - Strong model (llama-3.3-70b) extracts precise financial data
 *   - Only runs on filings where Pass 1 found data, saving 50-70% cost
 *
 * Includes 500ms delays between calls to avoid rate limits.
 */
export async function analyzeSECFilings(
  filings: SECFiling[],
  maxFilings = 5
): Promise<SECAnalysisResult> {
  if (filings.length === 0) {
    return { extracts: [], totalTokens: 0, promptTokens: 0, completionTokens: 0 };
  }

  const actualCount = Math.min(filings.length, maxFilings);
  logger.info(`SEC two-pass analysis: ${actualCount} filings (max ${maxFilings})`);

  const client = createClient();
  const extracts: SECFinancialExtract[] = [];
  let totalTokens = 0;
  let totalPrompt = 0;
  let totalCompletion = 0;

  // Process filings in order of priority (8-K first, then 10-Q, then 10-K)
  const sorted = [...filings].sort((a, b) => {
    const prio = (f: SECFiling) =>
      f.formType === "8-K" ? 0 : f.formType === "10-Q" ? 1 : f.formType === "10-K" ? 2 : 3;
    return prio(a) - prio(b);
  });

  const toProcess = sorted.slice(0, maxFilings);

  // ═══ Pass 1: Flag all filings with fast model ═══
  logger.info(`Pass 1: Flagging ${toProcess.length} filings with ${config.ai.fastModel}...`);
  const flaggedResults: { filing: SECFiling; flag: FlagResult }[] = [];

  for (let i = 0; i < toProcess.length; i++) {
    const filing = toProcess[i];
    const start = Date.now();
    const flag = await flagFiling(client, filing);
    flaggedResults.push({ filing, flag });

    if (flag.hasData) {
      logger.info(`  ✓ ${filing.ticker} ${filing.formType}: ${flag.reason} (${Date.now() - start}ms)`);
    } else {
      logger.info(`  ✗ ${filing.ticker} ${filing.formType}: ${flag.reason} (${Date.now() - start}ms)`);
    }

    // Small delay between flagging calls
    if (i < toProcess.length - 1) await sleep(300);
  }

  const flagged = flaggedResults.filter((r) => r.flag.hasData).map((r) => r.filing);
  logger.info(`Pass 1 complete: ${flagged.length}/${toProcess.length} filings flagged for extraction`);

  // ═══ Pass 2: Extract from flagged filings with strong model ═══
  if (flagged.length === 0) {
    logger.info("Pass 2: No filings flagged — skipping extraction");
    return { extracts: [], totalTokens, promptTokens: totalPrompt, completionTokens: totalCompletion };
  }

  logger.info(`Pass 2: Extracting financial data from ${flagged.length} filings with ${config.ai.model}...`);

  for (let i = 0; i < flagged.length; i++) {
    const filing = flagged[i];
    logger.info(`  [${i + 1}/${flagged.length}] ${filing.ticker} ${filing.formType} (${filing.filingDate})`);

    // 500ms delay between extractions to avoid rate limits
    if (i > 0) await sleep(500);

    const result = await processFiling(client, filing);
    totalTokens += result.tokenUsage.totalTokens;
    totalPrompt += result.tokenUsage.promptTokens;
    totalCompletion += result.tokenUsage.completionTokens;

    if (result.extract) {
      extracts.push(result.extract);
    }
  }

  logger.info(
    `SEC two-pass analysis complete: ${extracts.length} extracts from ${flagged.length} flagged filings ` +
    `(${extracts.filter((e) => e.impactScore >= 7).length} high-impact, ` +
    `${totalTokens} tokens used)`
  );

  return {
    extracts,
    totalTokens,
    promptTokens: totalPrompt,
    completionTokens: totalCompletion,
  };
}

// ─── Highlight Formatting ───────────────────────────────

/**
 * Get a human-readable summary of a financial extract.
 * Returns formatted text suitable for inclusion in the Telegram digest.
 */
export function formatSECExtract(extract: SECFinancialExtract): string {
  const parts: string[] = [];

  parts.push(`<b>${extract.companyName} (${extract.ticker})</b> — ${extract.formType} filed ${extract.filingDate}`);
  parts.push("");

  const dataLines: string[] = [];

  if (extract.capex !== null) {
    dataLines.push(`💰 Capex: <b>$${extract.capex.toFixed(0)}M</b>`);
  }
  if (extract.capexGuidance !== null) {
    dataLines.push(`📊 Capex Guidance: <b>$${extract.capexGuidance.toFixed(0)}M</b>`);
  }
  if (extract.aiRevenue !== null) {
    const growth = extract.aiRevenueGrowthPct !== null
      ? ` (${extract.aiRevenueGrowthPct >= 0 ? "+" : ""}${extract.aiRevenueGrowthPct.toFixed(1)}% YoY)`
      : "";
    dataLines.push(`🤖 AI/DC Revenue: <b>$${extract.aiRevenue.toFixed(0)}M</b>${growth}`);
  }
  if (extract.grossMargin !== null) {
    dataLines.push(`📈 Gross Margin: <b>${extract.grossMargin.toFixed(1)}%</b>`);
  }
  if (extract.operatingMargin !== null) {
    dataLines.push(`📉 Operating Margin: <b>${extract.operatingMargin.toFixed(1)}%</b>`);
  }
  if (extract.inventory !== null) {
    dataLines.push(`📦 Inventory: <b>$${extract.inventory.toFixed(0)}M</b>`);
  }
  if (extract.revenueGuidance !== null) {
    dataLines.push(`🎯 Revenue Guidance (next Q): <b>$${extract.revenueGuidance.toFixed(0)}M</b>`);
  }
  if (extract.epsGuidance !== null) {
    dataLines.push(`💵 EPS Guidance: <b>$${extract.epsGuidance.toFixed(2)}</b>`);
  }

  if (dataLines.length > 0) {
    parts.push(...dataLines.map((l) => `  ${l}`));
    parts.push("");
  }

  if (extract.keyTakeaways.length > 0) {
    parts.push(`  <i>${extract.keyTakeaways.slice(0, 2).join(" • ")}</i>`);
    parts.push("");
  }

  // Impact indicator
  const impactEmoji = extract.impactScore >= 8 ? "🔥" : extract.impactScore >= 6 ? "⚡" : "📌";
  const impactLabel = extract.impactScore >= 8 ? "HIGH IMPACT" : extract.impactScore >= 6 ? "NOTABLE" : "INFO";
  const impactColor = extract.impactScore >= 8 ? "🔴" : extract.impactScore >= 6 ? "🟡" : "⚪";
  parts.push(`  ${impactEmoji} ${impactColor} <b>${impactLabel}</b> (${extract.impactScore}/10) — ${extract.impactRationale}`);

  return parts.join("\n");
}
