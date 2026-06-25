import { describe, it, expect } from "vitest";
import { attachGroundingNotes } from "./grounding";
import type { ProcessedArticle } from "../processor/ai";
import type { SECFinancialExtract } from "../processor/sec";
import type { EarningsAnalysis } from "../processor/earnings";
import type { StockPrice } from "./stocks";

function makeArticle(overrides: Partial<ProcessedArticle> = {}): ProcessedArticle {
  return {
    title: "Test article",
    url: "https://example.com/test",
    source: "Test Source",
    summary: "A test summary.",
    impact: "Bullish",
    impactScore: 8,
    affectedStocks: [],
    reason: "test",
    category: "Chips & GPUs",
    ...overrides,
  };
}

function makeSecExtract(ticker: string, overrides: Partial<SECFinancialExtract> = {}): SECFinancialExtract {
  return {
    ticker,
    formType: "8-K",
    filingDate: "2026-06-20",
    companyName: `${ticker} Corp`,
    capex: 500,
    capexGuidance: null,
    capexSource: "",
    aiRevenue: null,
    aiRevenueGrowthPct: null,
    aiRevenueSource: "",
    grossMargin: null,
    operatingMargin: null,
    marginSource: "",
    inventory: null,
    inventoryTurnover: null,
    inventorySource: "",
    revenueGuidance: null,
    epsGuidance: null,
    guidanceText: "",
    impactScore: 8,
    impactRationale: "",
    keyTakeaways: [],
    ...overrides,
  };
}

function makeEarningsAnalysis(ticker: string, overrides: Partial<EarningsAnalysis> = {}): EarningsAnalysis {
  return {
    ticker,
    companyName: `${ticker} Corp`,
    year: 2026,
    quarter: 2,
    date: "2026-06-15",
    segments: [],
    metrics: {
      revenueGuidance: 5000,
      epsGuidance: null,
      capexGuidance: null,
      aiRevenueMentioned: null,
      aiRevenueGrowthPct: null,
      capexSpend: null,
      date: "2026-06-15",
    },
    tone: { overall: "bullish", confidence: 8, keyPhrase: "strong growth", risksMentioned: [] },
    delta: {
      prevRevenueGuidance: 4500,
      currRevenueGuidance: 5000,
      revenueGuidanceChangePct: 11.1,
      prevCapexGuidance: null,
      currCapexGuidance: null,
      capexGuidanceChangePct: null,
      toneDirection: "improving",
    },
    summary: "",
    keyTakeaways: [],
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    ...overrides,
  };
}

function makeStockPrice(ticker: string, changePercent: number): StockPrice {
  return { ticker, price: 100, change: changePercent, changePercent, previousClose: 100 };
}

describe("attachGroundingNotes", () => {
  it("attaches a grounding note when a matching SEC extract exists", () => {
    const article = makeArticle({ affectedStocks: ["NVDA"] });
    const sec = makeSecExtract("NVDA", { impactScore: 8 });

    attachGroundingNotes([article], [sec], [], new Map());

    expect(article.groundingNote).toBeDefined();
    expect(article.groundingNote).toContain("NVDA");
    expect(article.groundingNote).toContain("8-K");
  });

  it("attaches a grounding note from earnings when delta exists", () => {
    const article = makeArticle({ affectedStocks: ["AMD"] });
    const earnings = makeEarningsAnalysis("AMD");

    attachGroundingNotes([article], [], [earnings], new Map());

    expect(article.groundingNote).toBeDefined();
    expect(article.groundingNote).toContain("AMD");
    expect(article.groundingNote).toContain("earnings");
  });

  it("leaves groundingNote undefined when no tickers match", () => {
    const article = makeArticle({ affectedStocks: ["AAPL"] });
    const sec = makeSecExtract("NVDA");

    attachGroundingNotes([article], [sec], [], new Map());

    expect(article.groundingNote).toBeUndefined();
  });

  it("picks the highest-impact candidate when multiple tickers match", () => {
    const article = makeArticle({ affectedStocks: ["NVDA", "AMD"] });
    const secNvda = makeSecExtract("NVDA", { impactScore: 9 });
    const secAmd = makeSecExtract("AMD", { impactScore: 6 });

    attachGroundingNotes([article], [secNvda, secAmd], [], new Map());

    expect(article.groundingNote).toBeDefined();
    expect(article.groundingNote).toContain("NVDA");
    expect(article.groundingNote).not.toContain("AMD");
  });
});
