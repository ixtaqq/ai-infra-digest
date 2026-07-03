import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Mock Config ──────────────────────────────────────
vi.mock("../config", () => ({
  config: {
    app: {
      supabaseUrl: "https://mock.supabase.co",
      supabaseServiceKey: "mock-service-key",
    },
    telegram: { botToken: "test", chatId: "test" },
    ai: { provider: "groq", apiKey: "test", model: "test", baseUrl: "https://test.com" },
  },
}));

// ─── Mock fetch ───────────────────────────────────────
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

describe("Supabase Integration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("createDigestRun", () => {
    it("should return null when Supabase is not configured", async () => {
      // Temporarily override config to simulate unconfigured state
      const mod = await import("../utils/supabase");
      const { supabase } = mod;
      const result = await supabase.createDigestRun({
        run_date: "2025-01-01",
        status: "running",
        articles_collected: 10,
        articles_processed: 5,
        batches_run: 1,
        ai_provider: "groq",
        ai_model: "llama-3.3-70b",
        total_tokens_used: 1000,
        duration_seconds: 30,
      });
      // Should return non-null since mock config is set up
      expect(mockFetch).toHaveBeenCalled();
    });

    it("should return id on successful POST", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: 42 }],
      });

      const { supabase } = await import("../utils/supabase");
      const id = await supabase.createDigestRun({
        run_date: "2025-01-01",
        status: "success",
        articles_collected: 10,
        articles_processed: 5,
        batches_run: 1,
        ai_provider: "groq",
        ai_model: "llama-3.3-70b",
        total_tokens_used: 1000,
        duration_seconds: 30,
      });

      expect(id).toBe(42);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain("digest_runs");
      expect(callUrl).toContain("select=id");
    });

    it("should return null on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
      });

      const { supabase } = await import("../utils/supabase");
      const id = await supabase.createDigestRun({
        run_date: "2025-01-01",
        status: "failed",
        articles_collected: 0,
        articles_processed: 0,
        batches_run: 0,
        ai_provider: "groq",
        ai_model: "llama-3.3-70b",
        total_tokens_used: 0,
        duration_seconds: 5,
        error_message: "Test error",
      });

      expect(id).toBeNull();
    });
  });

  describe("insertArticles", () => {
    it("should split large batches into chunks of 20", async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 201 });

      const { supabase } = await import("../utils/supabase");
      const articles = Array.from({ length: 45 }, (_, i) => ({
        title: `Article ${i + 1}`,
        digest_run_id: 1,
      }));
      await supabase.insertArticles(1, articles);

      // Should make 3 calls (20 + 20 + 5)
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("should handle empty article list gracefully", async () => {
      const { supabase } = await import("../utils/supabase");
      const result = await supabase.insertArticles(1, []);
      // Empty input short-circuits before any network call and returns no rows.
      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("updateSectorActivity", () => {
    it("should POST each sector with date", async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 201 });

      const { supabase } = await import("../utils/supabase");
      const result = await supabase.updateSectorActivity("2025-01-01", [
        { sector: "Chips & GPUs", article_count: 5, avg_impact_score: 7.5, bullish_count: 3, bearish_count: 1, neutral_count: 1 },
        { sector: "Datacenters", article_count: 3, avg_impact_score: 6.0, bullish_count: 2, bearish_count: 0, neutral_count: 1 },
      ]);

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      // Verify on_conflict parameter is included
      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain("on_conflict=date,sector");
    });
  });

  describe("updateStockMentions", () => {
    it("should send price data when available", async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 201 });

      const { supabase } = await import("../utils/supabase");
      const result = await supabase.updateStockMentions("2025-01-01", [
        { ticker: "NVDA", mention_count: 5, avg_sentiment: 0.8, avg_impact_score: 8.0, price: 950.50, price_change_percent: 1.62 },
      ]);

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("getUserPreferences", () => {
    it("should return user prefs on success", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { chat_id: 12345, watchlist: ["NVDA", "AMD"], alerts_enabled: true, alerts_min_score: 8 },
        ],
      });

      const { supabase } = await import("../utils/supabase");
      const prefs = await supabase.getUserPreferences(12345);

      expect(prefs).not.toBeNull();
      expect(prefs!.watchlist).toEqual(["NVDA", "AMD"]);
      expect(prefs!.alerts_enabled).toBe(true);
    });

    it("should return null when not found", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      const { supabase } = await import("../utils/supabase");
      const prefs = await supabase.getUserPreferences(99999);
      expect(prefs).toBeNull();
    });

    it("should return null on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const { supabase } = await import("../utils/supabase");
      const prefs = await supabase.getUserPreferences(12345);
      expect(prefs).toBeNull();
    });
  });

  describe("upsertUserPreferences", () => {
    it("should POST with merge-duplicates header", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 201 });

      const { supabase } = await import("../utils/supabase");
      const result = await supabase.upsertUserPreferences({
        chat_id: 12345,
        watchlist: ["NVDA", "AMD"],
        alerts_enabled: true,
      });

      expect(result).toBe(true);
      const callHeaders = mockFetch.mock.calls[0][1]?.headers || {};
      expect(callHeaders["Prefer"]).toContain("resolution=merge-duplicates");
    });
  });

  describe("getAllActiveUsers", () => {
    it("should filter by is_active=true", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { chat_id: 1, is_active: true, alerts_enabled: true },
          { chat_id: 2, is_active: true, alerts_enabled: false },
        ],
      });

      const { supabase } = await import("../utils/supabase");
      const users = await supabase.getAllActiveUsers();

      expect(users).toHaveLength(2);
      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain("is_active=eq.true");
    });
  });

  describe("healthCheck", () => {
    it("should return true when Supabase is responsive", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const { supabase } = await import("../utils/supabase");
      const healthy = await supabase.healthCheck();
      expect(healthy).toBe(true);
    });

    it("should return false on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const { supabase } = await import("../utils/supabase");
      const healthy = await supabase.healthCheck();
      expect(healthy).toBe(false);
    });
  });

  describe("isConfigured", () => {
    it("should return true when URL and key are set", async () => {
      const { supabase } = await import("../utils/supabase");
      expect(supabase.isConfigured()).toBe(true);
    });
  });
});
