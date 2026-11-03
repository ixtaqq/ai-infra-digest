import { describe, expect, it } from "vitest";
import { correctAiTickers, normalizeTickerSymbols } from "./tickers";

describe("correctAiTickers", () => {
  it("replaces names and products the model writes with listed tickers", () => {
    expect(correctAiTickers(["AWS", "KLA", "LAM", "MARV", "INTEL", "ARISTA", "LMNT", "LUM", "ASE"])).toEqual([
      "AMZN", "KLAC", "LRCX", "MRVL", "INTC", "ANET", "LITE", "ASX",
    ]);
  });

  it("drops companies with no US listing", () => {
    expect(correctAiTickers(["SKH", "KIOXIA", "CXMT", "NVDA"])).toEqual(["NVDA"]);
  });

  it("merges a correction with the real ticker and normalizes case", () => {
    expect(correctAiTickers(["aws", "AMZN"])).toEqual(["AMZN"]);
  });

  it("leaves watchlist normalization unchanged", () => {
    expect(normalizeTickerSymbols(["aws"])).toEqual(["AWS"]);
  });
});
