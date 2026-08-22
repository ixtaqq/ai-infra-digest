import { describe, expect, it } from "vitest";
import type { DigestResult } from "../processor/ai";
import { assessSignalQuality, evaluateSignalQuality } from "./signal-quality";

describe("signal quality evaluation", () => {
  it("measures provenance, ticker validity, and high-impact justification", () => {
    const digest = {
      articles: [
        {
          title: "Verified",
          url: "https://example.com/verified",
          source: "Wire",
          summary: "Summary",
          impact: "Bullish",
          impactScore: 9,
          affectedStocks: ["NVDA"],
          reason: "Unexpected capacity expansion changes forward supply.",
          category: "Chips & GPUs",
          sourceIdentityVerified: true,
        },
        {
          title: "Weak",
          url: "https://example.com/weak",
          source: "Blog",
          summary: "Summary",
          impact: "Neutral",
          impactScore: 5,
          affectedStocks: [],
          invalidTickerCount: 1,
          reason: "",
          category: "Datacenters",
        },
      ],
      topStocks: [],
      marketOutlook: "Neutral",
      summary: "Summary",
      categories: {},
      usage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 },
      batchesRun: 1,
    } as unknown as DigestResult;

    expect(evaluateSignalQuality(digest)).toEqual({
      articleCount: 2,
      sourceIdentityCoverage: 0.5,
      invalidTickerCount: 1,
      highImpactArticleCount: 1,
      highImpactJustificationRate: 1,
    });
  });

  it("returns bounded zero-safe metrics for an empty digest", () => {
    expect(
      evaluateSignalQuality({ articles: [] } as unknown as DigestResult)
    ).toEqual({
      articleCount: 0,
      sourceIdentityCoverage: 0,
      invalidTickerCount: 0,
      highImpactArticleCount: 0,
      highImpactJustificationRate: 0,
    });
  });

  it("passes a provenance-safe, ticker-valid edition", () => {
    expect(
      assessSignalQuality({
        articleCount: 10,
        sourceIdentityCoverage: 1,
        invalidTickerCount: 0,
        highImpactArticleCount: 2,
        highImpactJustificationRate: 1,
      })
    ).toEqual({ passed: true, issues: [] });
  });

  it("reports every breached quality baseline", () => {
    expect(
      assessSignalQuality({
        articleCount: 10,
        sourceIdentityCoverage: 0.8,
        invalidTickerCount: 2,
        highImpactArticleCount: 3,
        highImpactJustificationRate: 0.667,
      })
    ).toEqual({
      passed: false,
      issues: [
        "source identity coverage is below 95%",
        "2 invalid ticker reference(s)",
        "one or more high-impact articles lack a substantive justification",
      ],
    });
  });
});
