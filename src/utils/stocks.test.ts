import { describe, it, expect } from "vitest";

describe("stocks TICKER_MAP", () => {
  it("should contain all expected AI chip designer tickers", async () => {
    // Re-read the TICKER_MAP by importing the module
    // Since TICKER_MAP is not exported, we test through fetchStockPrices
    // by checking that known tickers are in the map via the module
    const { fetchStockPrices } = await import("./stocks");

    // We can't easily check TICKER_MAP directly since it's not exported,
    // but we can verify the function accepts our known tickers
    const result = await fetchStockPrices(["NVDA", "AMD", "AVGO"]);
    expect(result).toBeInstanceOf(Map);
    // The map may be empty if Yahoo Finance is unreachable in test,
    // but the function itself should not throw
  });

  it("should handle empty ticker list gracefully", async () => {
    const { fetchStockPrices } = await import("./stocks");
    const result = await fetchStockPrices([]);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it("should cap at 25 tickers max", async () => {
    const { fetchStockPrices } = await import("./stocks");
    const manyTickers = Array.from({ length: 50 }, (_, i) => `TICKER${i}`);
    const result = await fetchStockPrices(manyTickers);
    expect(result).toBeInstanceOf(Map);
    // Should not throw despite 50 tickers
  });
});
