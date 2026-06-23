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

  it("should include value chain coverage when categories have articles", async () => {
    const { formatDigestTelegram } = await import("./telegram");
    const cat = emptyCategories();
    cat["Chips & GPUs"] = [
      {
        title: "Test Article",
        url: "https://example.com",
        source: "Test",
        summary: "Test",
        impact: "Neutral" as const,
        impactScore: 5,
        affectedStocks: [],
        reason: "Test",
        category: "Chips & GPUs" as const,
      },
    ];

    const result = formatDigestTelegram({
      articles: [
        {
          title: "Test Article",
          url: "https://example.com",
          source: "Test",
          summary: "Test",
          impact: "Neutral" as const,
          impactScore: 5,
          affectedStocks: [],
          reason: "Test",
          category: "Chips & GPUs" as const,
        },
      ],
      topStocks: [],
      marketOutlook: "Test.",
      summary: "Test.",
      categories: cat,
      usage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 },
      batchesRun: 0,
    });
    expect(result).toContain("VALUE CHAIN");
    expect(result).toContain("Chips");
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
