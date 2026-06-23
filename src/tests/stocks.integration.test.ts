import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Mock Config ──────────────────────────────────────
vi.mock("../config", () => ({
  config: {
    app: {
      cacheDir: "/tmp/test-cache",
      timezone: "Asia/Kuala_Lumpur",
      maxArticlesPerSource: 5,
    },
    telegram: { botToken: "test", chatId: "test" },
    ai: { provider: "groq", apiKey: "test", model: "test", baseUrl: "https://test.com" },
  },
}));

// ─── Mock fetch ───────────────────────────────────────
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

describe("Stocks Integration (Yahoo Finance)", () => {
  beforeEach(() => {
    vi.clearAllMocks(); // clear calls but keep implementations
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("fetchStockPrices", () => {
    it("should return empty map for empty ticker list", async () => {
      const { fetchStockPrices } = await import("../utils/stocks");
      const result = await fetchStockPrices([]);
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    it("should parse Yahoo Finance JSON response for a single ticker", async () => {
      const jsonResponse = {
        chart: {
          result: [
            {
              meta: {
                regularMarketPrice: 950.50,
                previousClose: 935.30,
                currency: "USD",
              },
              indicators: {
                quote: [
                  { close: [935.30, 940.00, 950.50] },
                ],
              },
            },
          ],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => jsonResponse,
      });

      const { fetchStockPrices } = await import("../utils/stocks");
      const result = await fetchStockPrices(["NVDA"]);

      expect(result.size).toBe(1);
      expect(result.has("NVDA")).toBe(true);

      const nvda = result.get("NVDA")!;
      expect(nvda.ticker).toBe("NVDA");
      expect(nvda.price).toBe(950.50);
      expect(nvda.previousClose).toBe(935.30);
      expect(nvda.change).toBeCloseTo(15.20, 1);
      expect(nvda.changePercent).toBeCloseTo(1.63, 1);
    });

    it("should parse multiple tickers", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            chart: { result: [{ meta: { regularMarketPrice: 950.50, previousClose: 935.30 } }] },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            chart: { result: [{ meta: { regularMarketPrice: 180.25, previousClose: 182.75 } }] },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            chart: { result: [{ meta: { regularMarketPrice: 1800.00, previousClose: 1755.00 } }] },
          }),
        });

      const { fetchStockPrices } = await import("../utils/stocks");
      const result = await fetchStockPrices(["NVDA", "AMD", "AVGO"]);

      expect(result.size).toBe(3);

      const amd = result.get("AMD")!;
      expect(amd.price).toBe(180.25);
      expect(amd.change).toBe(-2.50);
      expect(amd.changePercent).toBeCloseTo(-1.37, 1);
    });

    it("should handle Yahoo API error gracefully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
      });

      const { fetchStockPrices } = await import("../utils/stocks");
      const result = await fetchStockPrices(["NVDA"]);

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    it("should handle network errors gracefully", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network timeout"));

      const { fetchStockPrices } = await import("../utils/stocks");
      const result = await fetchStockPrices(["NVDA"]);

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    it("should handle missing meta data gracefully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ chart: { result: [{}] } }),
      });

      const { fetchStockPrices } = await import("../utils/stocks");
      const result = await fetchStockPrices(["NVDA"]);

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0); // No meta → skipped
    });

    it("should handle empty chart result", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ chart: { result: [] } }),
      });

      const { fetchStockPrices } = await import("../utils/stocks");
      const result = await fetchStockPrices(["NVDA"]);

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    it("should filter unknown tickers through TICKER_MAP", async () => {
      // Only NVDA is in TICKER_MAP; FAKE is not
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          chart: { result: [{ meta: { regularMarketPrice: 950.50, previousClose: 935.30 } }] },
        }),
      });

      const { fetchStockPrices } = await import("../utils/stocks");
      // FAKE is not in TICKER_MAP and has length > 5 → filtered out
      const result = await fetchStockPrices(["FAKETICKER123"]);
      expect(result.size).toBe(0); // Should not call fetch for unknown tickers
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
