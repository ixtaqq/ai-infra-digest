import { z } from "zod";
import type { PriceWatch } from "../utils/price-watch";
import type { StockPrice } from "../utils/stocks";
import type { GeneratedDigest } from "./types";
import {
  AI_ANALYSIS_SCHEMA_VERSION,
  AI_PROMPT_VERSION,
} from "../processor/versions";

export const DIGEST_PUBLICATION_SCHEMA_VERSION = 1;

export interface DigestPublicationPayload {
  schemaVersion: number;
  promptVersion: string;
  analysisSchemaVersion: number;
  runDate: string;
  formattedMessage: string;
  digest: GeneratedDigest["digest"];
  articlesCollected: number;
  feedStatuses: GeneratedDigest["feedStatuses"];
  secExtracts: GeneratedDigest["secExtracts"];
  earningsAnalyses: GeneratedDigest["earningsAnalyses"];
  stockPrices: [string, StockPrice][];
  whatChanged?: string;
  deepDive?: GeneratedDigest["deepDive"];
  capabilities: GeneratedDigest["capabilities"];
}

export function serializeDigestPublication(
  generated: GeneratedDigest
): DigestPublicationPayload {
  return {
    schemaVersion: DIGEST_PUBLICATION_SCHEMA_VERSION,
    promptVersion: AI_PROMPT_VERSION,
    analysisSchemaVersion: AI_ANALYSIS_SCHEMA_VERSION,
    runDate: generated.runDate,
    formattedMessage: generated.formattedMessage,
    digest: generated.digest,
    articlesCollected: generated.articlesCollected,
    feedStatuses: generated.feedStatuses,
    secExtracts: generated.secExtracts,
    earningsAnalyses: generated.earningsAnalyses,
    stockPrices: [...generated.stockPrices.entries()],
    whatChanged: generated.whatChanged,
    deepDive: generated.deepDive,
    capabilities: generated.capabilities,
  };
}

const number = z.number().finite();
const count = number.int().nonnegative();
const strings = z.array(z.string());
const capability = z.object({ state: z.enum(["enabled", "disabled", "degraded"]), detail: z.string() });
const article = z.object({
  title: z.string(), url: z.string(), source: z.string(), summary: z.string(),
  impact: z.enum(["Bullish", "Bearish", "Neutral"]), impactScore: number,
  affectedStocks: strings, reason: z.string(), category: z.string(),
  bearCase: z.string().optional(), groundingNote: z.string().optional(),
  embedding: z.array(number).optional(), effectiveScore: number.optional(),
  corroborationCount: count.optional(), relevanceScore: number.optional(),
  isSECFiling: z.boolean().optional(), isRehash: z.boolean().optional(),
  sourceIdentityVerified: z.boolean().optional(), invalidTickerCount: count.optional(),
  rankingExplanation: z.object({
    version: z.literal(1), baseImpactScore: number, relevanceScore: number.nullable(),
    multipliers: z.object({ sourceTrust: number, sourceCredibility: number,
      sectorTrust: number, corroboration: number, novelty: number }),
    corroborationCount: count, uncappedScore: number, finalScore: number,
    cap: z.literal("pr_wire").nullable(), reasons: strings,
  }).optional(),
}).passthrough();
const usage = z.object({ totalTokens: count, promptTokens: count, completionTokens: count });
const sec = z.object({
  ticker: z.string(), formType: z.string(), filingDate: z.string(), companyName: z.string(),
  capex: number.nullable(), capexGuidance: number.nullable(), capexSource: z.string(),
  aiRevenue: number.nullable(), aiRevenueGrowthPct: number.nullable(), aiRevenueSource: z.string(),
  grossMargin: number.nullable(), operatingMargin: number.nullable(), marginSource: z.string(),
  inventory: number.nullable(), inventoryTurnover: number.nullable(), inventorySource: z.string(),
  revenueGuidance: number.nullable(), epsGuidance: number.nullable(), guidanceText: z.string(),
  impactScore: number, impactRationale: z.string(), keyTakeaways: strings,
  accessionNumber: z.string().optional(), primaryDocumentUrl: z.string().optional(), items: strings.optional(),
});
const earnings = z.object({
  ticker: z.string(), companyName: z.string(), year: count, quarter: number.int().min(1).max(4),
  date: z.string(), summary: z.string(), keyTakeaways: strings,
  totalTokens: count, promptTokens: count, completionTokens: count,
  segments: z.array(z.object({ topic: z.string(), relevance: number, keyQuote: z.string(), summary: z.string() })),
  metrics: z.object({ revenueGuidance: number.nullable(), epsGuidance: number.nullable(),
    capexGuidance: number.nullable(), aiRevenueMentioned: number.nullable(),
    aiRevenueGrowthPct: number.nullable(), capexSpend: number.nullable(), date: z.string() }),
  tone: z.object({ overall: z.enum(["bullish", "cautious", "neutral", "bearish"]),
    confidence: number, keyPhrase: z.string(), risksMentioned: strings }),
  delta: z.object({ prevRevenueGuidance: number.nullable(), currRevenueGuidance: number.nullable(),
    revenueGuidanceChangePct: number.nullable(), prevCapexGuidance: number.nullable(),
    currCapexGuidance: number.nullable(), capexGuidanceChangePct: number.nullable(),
    toneDirection: z.enum(["improving", "worsening", "stable"]) }).nullable(),
});
const publicationSchema = z.object({
  schemaVersion: z.literal(DIGEST_PUBLICATION_SCHEMA_VERSION),
  promptVersion: z.string().min(1), analysisSchemaVersion: count,
  runDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), formattedMessage: z.string().min(1),
  digest: z.object({ articles: z.array(article),
    topStocks: z.array(z.object({ ticker: z.string(), reason: z.string(), sentiment: z.enum(["positive", "negative", "neutral"]) })),
    marketOutlook: z.string(), summary: z.string(), categories: z.record(z.array(article)),
    usage, batchesRun: count }),
  articlesCollected: count,
  feedStatuses: z.array(z.object({ name: z.string(), url: z.string(),
    status: z.enum(["success", "failed"]), articlesFetched: count,
    articles: z.array(z.object({ title: z.string(), url: z.string(), summary: z.string(),
      source: z.string(), date: z.union([z.string(), z.date()]), contentSnippet: z.string() })) })),
  secExtracts: z.array(sec), earningsAnalyses: z.array(earnings),
  stockPrices: z.array(z.tuple([z.string(), z.object({ ticker: z.string(), price: number,
    change: number, changePercent: number, previousClose: number })])),
  capabilities: z.object({ primaryAi: capability, fallbackAi: capability, embeddings: capability,
    earnings: capability, supabase: capability, slack: capability, email: capability }),
  whatChanged: z.string().optional(),
  deepDive: z.object({ url: z.string(), title: z.string(), bullCase: z.string(), bearCase: z.string(), contextNote: z.string() }).optional(),
});
function isPublicationPayload(value: unknown): value is DigestPublicationPayload {
  return publicationSchema.safeParse(value).success;
}

export function deserializeDigestPublication(
  payload: unknown,
  activeWatches: PriceWatch[],
  startTime = Date.now(),
  publicationId?: number
): GeneratedDigest {
  if (!isPublicationPayload(payload)) {
    throw new Error("Invalid digest publication payload");
  }

  return {
    publicationId,
    runDate: payload.runDate,
    startTime,
    formattedMessage: payload.formattedMessage,
    digest: payload.digest,
    articlesCollected: payload.articlesCollected,
    feedStatuses: payload.feedStatuses,
    secExtracts: payload.secExtracts,
    earningsAnalyses: payload.earningsAnalyses,
    stockPrices: new Map(payload.stockPrices),
    whatChanged: payload.whatChanged,
    deepDive: payload.deepDive,
    activeWatches,
    capabilities: payload.capabilities,
  };
}
