import { expect, it } from "vitest";
import { benchmarkSchema, compareBenchmark } from "./benchmark";

const cases = Array.from({ length: 50 }, (_, index) => ({
  id: String(index), sourceUrl: "https://example.com/fixture", sourceText: "Synthetic source text for a unit test, not reviewed editorial evidence.",
  reviewedBy: "Unit test fixture", reviewedAt: "2026-01-01T00:00:00Z", relevant: true, tickers: ["NVDA"], impact: 7, supportedClaims: ["Fixture claim"],
}));

it("rejects short or duplicated reference sets", () => {
  expect(benchmarkSchema.safeParse(cases.slice(0, 49)).success).toBe(false);
  expect(benchmarkSchema.safeParse([...cases.slice(0, 49), cases[0]]).success).toBe(false);
});

it("counts missing coverage, incorrect tickers and unsupported claims", () => {
  const result = compareBenchmark(cases, [{ id: "0", relevant: false, tickers: ["AMD"], impact: 9, unsupportedClaims: 1 }]);
  expect(result).toMatchObject({ missing: 49, relevanceAccuracy: 0, tickerAccuracy: 0, meanImpactError: 2, unsupportedClaims: 1 });
});

it("does not silently overwrite duplicate prediction IDs", () => {
  const prediction = { id: "0", relevant: true, tickers: ["NVDA"], impact: 7, unsupportedClaims: 0 };
  expect(() => compareBenchmark(cases, [prediction, prediction])).toThrow("unique IDs");
});
