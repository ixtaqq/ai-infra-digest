import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();

function yahooResponse(ticker: string, price = 100, previousClose = 95) {
  return {
    ok: true,
    json: async () => ({
      chart: {
        result: [{ meta: { regularMarketPrice: price, previousClose } }],
      },
    }),
    ticker,
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stocks TICKER_MAP", () => {
  it("should contain all expected AI chip designer tickers", async () => {
    mockFetch.mockImplementation(async (input: string) => {
      const ticker = input.split("/chart/")[1].split("?")[0];
      return yahooResponse(ticker);
    });

    const { fetchStockPrices } = await import("./stocks");
    const result = await fetchStockPrices(["NVDA", "AMD", "AVGO"]);

    expect(result.size).toBe(3);
    expect(result.get("NVDA")?.price).toBe(100);
  });

  it("should handle empty ticker list gracefully", async () => {
    const { fetchStockPrices } = await import("./stocks");
    const result = await fetchStockPrices([]);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it("should cap at 25 tickers max", async () => {
    const { fetchStockPrices } = await import("./stocks");
    mockFetch.mockImplementation(async (input: string) => {
      const ticker = input.split("/chart/")[1].split("?")[0];
      return yahooResponse(ticker);
    });

    const manyTickers = Array.from({ length: 30 }, (_, i) => `T${i}`);
    const result = await fetchStockPrices(manyTickers);

    expect(result).toBeInstanceOf(Map);
    expect(mockFetch).toHaveBeenCalledTimes(25);
  });

  it("fetches in fixed-size batches and isolates one ticker failure", async () => {
    let activeRequests = 0;
    let maxActiveRequests = 0;
    mockFetch.mockImplementation(async (input: string) => {
      const ticker = input.split("/chart/")[1].split("?")[0];
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);

      await new Promise((resolve) => setTimeout(resolve, 1));
      activeRequests -= 1;

      if (ticker === "AMD") {
        throw new Error("simulated Yahoo failure");
      }
      return yahooResponse(ticker);
    });

    const { fetchStockPrices } = await import("./stocks");
    const result = await fetchStockPrices([
      "NVDA", "AMD", "AVGO", "QCOM", "MRVL", "ARM", "TSM",
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(7);
    expect(maxActiveRequests).toBe(5);
    expect(result.has("AMD")).toBe(false);
    expect(result.size).toBe(6);
  });
});
