import { describe, expect, it } from "vitest";
import type { DigestResult } from "../processor/ai";
import { personalizeDigest } from "./personalization";

function digestFixture(): DigestResult {
  const article = {
    title: "NVIDIA update",
    url: "https://example.com/nvidia",
    source: "Example",
    summary: "A".repeat(120),
    impact: "Bullish" as const,
    impactScore: 8,
    affectedStocks: ["NVDA"],
    reason: "Demand is accelerating.",
    category: "Chips & GPUs" as const,
  };
  return {
    articles: [article],
    topStocks: [{ ticker: "NVDA", reason: "Leader", sentiment: "positive" }],
    marketOutlook: "Constructive",
    summary: "Daily summary",
    categories: {
      "Chips & GPUs": [article],
      "Cloud & Hyperscalers": [],
      "Datacenters": [],
      "Networking": [],
      "Power & Utilities": [],
      "Cooling Infrastructure": [],
      "AI Models & Labs": [],
      "Semiconductor Manufacturing": [],
      "M&A and Partnerships": [],
      "Earnings & Guidance": [],
    },
    usage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 },
    batchesRun: 1,
  };
}

describe("personalizeDigest", () => {
  it("returns the original digest when no preference changes output", () => {
    const digest = digestFixture();
    const result = personalizeDigest(digest, { chat_id: 1, digest_length: "standard" });

    expect(result.applied).toBe(false);
    expect(result.digest).toBe(digest);
  });

  it("rebuilds categories from brief article objects", () => {
    const result = personalizeDigest(digestFixture(), { chat_id: 1, digest_length: "brief" });

    expect(result.digest.articles[0].summary.length).toBeLessThan(120);
    expect(result.digest.categories["Chips & GPUs"][0]).toBe(result.digest.articles[0]);
    expect(result.digest.articles[0].reason).toBe("");
  });

  it("keeps analyst rationale only for detailed output", () => {
    const result = personalizeDigest(digestFixture(), { chat_id: 1, digest_length: "detailed" });

    expect(result.digest.articles[0].reason).toBe("Demand is accelerating.");
    expect(result.note).toContain("detailed digest");
  });
});
