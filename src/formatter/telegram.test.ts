import { describe, it, expect } from "vitest";
import type { ProcessedArticle, NewsCategory } from "../processor/ai";

// Helper: create a mock categories object with empty arrays for all 10 categories
function emptyCategories(): Record<NewsCategory, ProcessedArticle[]> {
  return {
    "Chips & GPUs": [],
    "Cloud & Hyperscalers": [],
    "Datacenters": [],
    "Networking": [],
    "Power & Utilities": [],
    "Cooling Infrastructure": [],
    "AI Models & Labs": [],
    "Semiconductor Manufacturing": [],
    "M&A and Partnerships": [],
    "Earnings & Guidance": [],
  };
}

describe("formatDigestTelegram", () => {
  it("should include header and date in the formatted message", async () => {
    const { formatDigestTelegram } = await import("./telegram");
    const result = formatDigestTelegram({
      articles: [],
      topStocks: [],
      marketOutlook: "Test outlook.",
      summary: "Test summary.",
      categories: emptyCategories(),
      usage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 },
      batchesRun: 0,
    });
    expect(result).toContain("AI Infra Morning Digest");
    expect(result).toContain("MARKET OUTLOOK");
  });

  it("should include articles when provided", async () => {
    const { formatDigestTelegram } = await import("./telegram");
    const cat = emptyCategories();
    cat["Chips & GPUs"] = [
      {
        title: "NVIDIA Launches New AI Chip",
        url: "https://example.com/nvidia",
        source: "NVIDIA",
        summary: "Summary here",
        impact: "Bullish" as const,
        impactScore: 8,
        affectedStocks: ["NVDA"],
        reason: "Good for NVIDIA",
        category: "Chips & GPUs" as const,
      },
    ];

    const result = formatDigestTelegram({
      articles: [
        {
          title: "NVIDIA Launches New AI Chip",
          url: "https://example.com/nvidia",
          source: "NVIDIA",
          summary: "Summary here",
          impact: "Bullish" as const,
          impactScore: 8,
          affectedStocks: ["NVDA"],
          reason: "Good for NVIDIA",
          category: "Chips & GPUs" as const,
        },
      ],
      topStocks: [
        { ticker: "NVDA", reason: "Key driver", sentiment: "positive" as const },
      ],
      marketOutlook: "Bullish on AI.",
      summary: "NVIDIA announced a new chip.",
      categories: cat,
      usage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 },
      batchesRun: 0,
    });
    expect(result).toContain("NVIDIA");
    expect(result).toContain("NVDA");
    expect(result).toContain("Bullish");
    expect(result).toContain("Chips");
  });

  it("renders summaries for standard digests and rationale only for detailed digests", async () => {
    const { formatDigestTelegram } = await import("./telegram");
    const article: ProcessedArticle = {
      title: "NVIDIA Launches New AI Chip",
      url: "https://example.com/nvidia",
      source: "NVIDIA",
      summary: "A useful article summary.",
      impact: "Bullish",
      impactScore: 8,
      affectedStocks: ["NVDA"],
      reason: "Demand should improve margins.",
      category: "Chips & GPUs",
    };
    const categories = emptyCategories();
    categories["Chips & GPUs"] = [article];
    const digest = {
      articles: [article],
      topStocks: [],
      marketOutlook: "Bullish on AI.",
      summary: "NVIDIA announced a new chip.",
      categories,
      usage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 },
      batchesRun: 0,
    };

    const standard = formatDigestTelegram(digest, { digestLength: "standard" });
    const detailed = formatDigestTelegram(digest, { digestLength: "detailed" });

    expect(standard).toContain("A useful article summary.");
    expect(standard).not.toContain("Demand should improve margins.");
    expect(detailed).toContain("A useful article summary.");
    expect(detailed).toContain("Demand should improve margins.");
  });

  it("shows the ranking explanation only in detailed digests", async () => {
    const { formatDigestTelegram } = await import("./telegram");
    const article: ProcessedArticle = {
      title: "Corroborated GPU demand",
      url: "https://example.com/ranked",
      source: "Reuters",
      summary: "Several sources report stronger demand.",
      impact: "Bullish",
      impactScore: 8,
      affectedStocks: ["NVDA"],
      reason: "Demand is broadening.",
      category: "Chips & GPUs",
      effectiveScore: 9.2,
      rankingExplanation: {
        version: 1,
        baseImpactScore: 8,
        relevanceScore: 9,
        multipliers: { sourceTrust: 1, sourceCredibility: 1.1, sectorTrust: 1, corroboration: 1.05, novelty: 1 },
        corroborationCount: 2,
        uncappedScore: 9.24,
        finalScore: 9.24,
        cap: null,
        reasons: ["established editorial source", "corroborated by 2 sources"],
      },
    };
    const categories = emptyCategories();
    categories["Chips & GPUs"] = [article];
    const digest = {
      articles: [article],
      topStocks: [],
      marketOutlook: "Constructive.",
      summary: "Demand improved.",
      categories,
      usage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 },
      batchesRun: 1,
    };

    expect(formatDigestTelegram(digest, { digestLength: "standard" })).not.toContain("Ranked 9.2");
    expect(formatDigestTelegram(digest, { digestLength: "detailed" })).toContain("Ranked 9.2");
    expect(formatDigestTelegram(digest, { digestLength: "detailed" })).toContain("corroborated by 2 sources");
  });

  it("should include stock prices when provided", async () => {
    const { formatDigestTelegram } = await import("./telegram");
    const stockPrices = new Map();
    stockPrices.set("NVDA", {
      ticker: "NVDA",
      price: 950.50,
      change: 15.20,
      changePercent: 1.62,
      previousClose: 935.30,
    });

    const result = formatDigestTelegram(
      {
        articles: [],
        topStocks: [
          { ticker: "NVDA", reason: "Key driver", sentiment: "positive" as const },
        ],
        marketOutlook: "Test.",
        summary: "Test.",
        categories: emptyCategories(),
        usage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 },
        batchesRun: 0,
      },
      { stockPrices }
    );
    expect(result).toContain("NVDA");
    expect(result).toContain("1.6");
  });

  it("leads with the TL;DR and renders numbered, linked stories with escaped URLs", async () => {
    const { formatDigestTelegram } = await import("./telegram");
    const { planMessageParts } = await import("../sender/message-parts");
    const article: ProcessedArticle = {
      title: "Test Article",
      url: "https://example.com/a?x=1&y=2",
      source: "Test",
      summary: "Article summary.",
      impact: "Neutral",
      impactScore: 5,
      affectedStocks: ["NVDA", "AMD"],
      reason: "Test",
      category: "Chips & GPUs",
    };
    const cat = emptyCategories();
    cat["Chips & GPUs"] = [article];

    const result = formatDigestTelegram({
      articles: [article],
      topStocks: [],
      marketOutlook: "Outlook text.",
      summary: "Summary text.",
      categories: cat,
      usage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 },
      batchesRun: 0,
    });
    expect(result.indexOf("Summary text.")).toBeLessThan(result.indexOf("Test Article"));
    expect(result.indexOf("Test Article")).toBeLessThan(result.indexOf("Outlook text."));
    expect(result).toContain('1. <a href="https://example.com/a?x=1&amp;y=2"><b>Test Article</b></a>');
    expect(result).toContain("⚪ Neutral · 5/10 · NVDA, AMD");
    expect(result).not.toContain("VALUE CHAIN");
    expect(() => planMessageParts(result)).not.toThrow();
  });

  it("should not include categories section when no articles exist", async () => {
    const { formatDigestTelegram } = await import("./telegram");
    const result = formatDigestTelegram({
      articles: [],
      topStocks: [],
      marketOutlook: "Quiet day.",
      summary: "No news today.",
      categories: emptyCategories(),
      usage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 },
      batchesRun: 0,
    });
    expect(result).toContain("AI Infra Morning Digest");
    expect(result).toContain("Quiet day.");
  });
});
