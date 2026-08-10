import { describe, expect, it } from "vitest";
import { calculateRanking, formatRankingSummary } from "./ranking";

describe("calculateRanking", () => {
  it("records every score component and human-readable reason", () => {
    const result = calculateRanking({
      impactScore: 8,
      relevanceScore: 9,
      sourceTrust: 1.1,
      sourceCredibility: 1.2,
      sectorTrust: 1,
      corroborationCount: 3,
      isRehash: false,
      isPRWire: false,
    });

    expect(result).toMatchObject({
      version: 1,
      baseImpactScore: 8,
      relevanceScore: 9,
      corroborationCount: 3,
      multipliers: { corroboration: 1.1, novelty: 1 },
      uncappedScore: 11.616,
      finalScore: 11.616,
      cap: null,
    });
    expect(result.reasons).toContain("reader-validated source");
    expect(result.reasons).toContain("corroborated by 3 sources");
  });

  it("records novelty penalties and PR-wire caps", () => {
    const result = calculateRanking({
      impactScore: 10,
      sourceTrust: 1.2,
      sourceCredibility: 1,
      sectorTrust: 1,
      corroborationCount: 2,
      isRehash: true,
      isPRWire: true,
    });

    expect(result.uncappedScore).toBe(7.56);
    expect(result.finalScore).toBe(6);
    expect(result.cap).toBe("pr_wire");
    expect(formatRankingSummary(result)).toContain("Ranked 6.0");
    expect(result.reasons).toContain("similar to recent coverage");
    expect(result.reasons).toContain("PR-wire score capped");
  });
});
