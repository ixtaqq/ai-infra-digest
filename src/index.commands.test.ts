import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CommandContext, CommandHandler } from "./sender/telegram";

/**
 * Unit tests for the /coverage and /thesis Telegram command handlers.
 * Command handlers had zero test coverage before this (flagged in the
 * /plan-eng-review Test Review — see docs/thesis-evolution-implementation-plan.md).
 */

const h = vi.hoisted(() => ({
  queryRowsMock: vi.fn(),
  fetchStockPricesMock: vi.fn(),
  upsertPriceWatchMock: vi.fn(),
  deletePriceWatchMock: vi.fn(),
  getUserPreferencesMock: vi.fn(),
  upsertUserPreferencesMock: vi.fn(),
  handlers: new Map<string, CommandHandler>(),
}));

vi.mock("./config", () => ({
  config: {
    ai: { provider: "groq", apiKey: "x", model: "m", fastModel: "f", baseUrl: "" },
    telegram: { botToken: "x", chatId: "1" },
    app: { timezone: "UTC", cacheDir: ".", maxArticlesPerSource: 5, roicAiApiKey: undefined },
  },
}));
vi.mock("./collector/rss", () => ({ collectArticles: vi.fn(), skipFeed: vi.fn(), resetSkippedFeeds: vi.fn() }));
vi.mock("./processor/ai", () => ({ processArticles: vi.fn(), NEWS_CATEGORIES: ["Chips & GPUs"], isSECFilingArticle: () => false }));
vi.mock("./collector/sec", () => ({ collectSECFilings: vi.fn(async () => ({ newFilings: [] })), getTopFilings: vi.fn(() => []) }));
vi.mock("./processor/sec", () => ({ analyzeSECFilings: vi.fn(async () => ({ extracts: [] })) }));
vi.mock("./collector/earnings", () => ({ collectEarningsTranscripts: vi.fn(async () => ({ transcripts: [] })) }));
vi.mock("./processor/earnings", () => ({ analyzeEarningsTranscripts: vi.fn(async () => ({ analyses: [], totalTokens: 0 })) }));
vi.mock("./utils/stocks", () => ({ fetchStockPrices: h.fetchStockPricesMock }));
vi.mock("./formatter/telegram", () => ({ formatDigestTelegram: vi.fn(() => "DIGEST_MSG") }));
vi.mock("./utils/dedup", () => ({ deduplicateArticles: (a: unknown[]) => a, buildCorroborationMap: vi.fn(() => new Map()) }));
vi.mock("./utils/metrics", () => ({ emitFeedFetch: vi.fn(), emitStockFetch: vi.fn(), emitDigestDelivery: vi.fn(), emitError: vi.fn() }));
vi.mock("./utils/ai-cache", () => ({ getCached: vi.fn(() => null), setCached: vi.fn() }));

// Capture every registered command handler into a local map instead of the
// real module-level registry, so this test can invoke a specific handler
// (e.g. "coverage", "thesis") directly with a constructed CommandContext.
vi.mock("./sender/telegram", () => ({
  sendDigestMessage: vi.fn(),
  sendDigestMessageToUser: vi.fn(),
  sendValidationFollowUp: vi.fn(),
  startInteractiveBot: vi.fn(),
  registerCommand: (name: string, handler: CommandHandler) => h.handlers.set(name, handler),
}));

vi.mock("./utils/supabase", () => ({
  supabase: {
    isConfigured: () => true,
    queryRows: h.queryRowsMock,
    upsertPriceWatch: h.upsertPriceWatchMock,
    deletePriceWatch: h.deletePriceWatchMock,
    getUserPreferences: h.getUserPreferencesMock,
    upsertUserPreferences: h.upsertUserPreferencesMock,
  },
}));

import { registerDigestCommands } from "./index";

function ctx(text: string): CommandContext {
  return { chatId: 1, text };
}

beforeEach(() => {
  vi.resetAllMocks();
  h.fetchStockPricesMock.mockResolvedValue(new Map());
  h.upsertPriceWatchMock.mockResolvedValue(true);
  h.deletePriceWatchMock.mockResolvedValue(true);
  h.getUserPreferencesMock.mockResolvedValue(null);
  h.upsertUserPreferencesMock.mockResolvedValue(true);
  h.handlers.clear();
  registerDigestCommands();
});

describe("/coverage command", () => {
  it("shows usage hint when no ticker is given", async () => {
    const result = await h.handlers.get("coverage")!(ctx("/coverage"));
    const text = typeof result === "string" ? result : result.text;
    expect(text).toContain("Usage");
  });

  it("renders recent coverage for a ticker, newest first", async () => {
    h.queryRowsMock.mockResolvedValueOnce([
      { title: "NVDA raises guidance", impact: "Bullish", impact_score: 9, reason: "Strong demand", created_at: "2026-07-03T00:00:00Z" },
      { title: "Blackwell delay reported", impact: "Bearish", impact_score: 6, reason: "Supply concerns", created_at: "2026-06-28T00:00:00Z" },
    ]);

    const result = await h.handlers.get("coverage")!(ctx("/coverage NVDA 14"));
    const text = typeof result === "string" ? result : result.text;

    expect(text).toContain("NVDA");
    expect(text).toContain("Last 14d");
    expect(text).toContain("NVDA raises guidance");
    expect(text).toContain("Blackwell delay reported");
    expect(h.queryRowsMock).toHaveBeenCalledWith(
      "articles",
      expect.stringContaining("affected_stocks=cs.{NVDA}")
    );
  });

  it("defaults to 14 days when no day count is given", async () => {
    h.queryRowsMock.mockResolvedValueOnce([]);
    const result = await h.handlers.get("coverage")!(ctx("/coverage NVDA"));
    const text = typeof result === "string" ? result : result.text;
    expect(text).toContain("last 14 days");
  });

  it("shows a not-configured message when Supabase is unavailable", async () => {
    // Re-register with isConfigured() false for this one test.
    vi.doMock("./utils/supabase", () => ({ supabase: { isConfigured: () => false, queryRows: h.queryRowsMock } }));
    vi.resetModules();
    const { registerDigestCommands: register2 } = await import("./index");
    h.handlers.clear();
    register2();
    const result = await h.handlers.get("coverage")!(ctx("/coverage NVDA"));
    const text = typeof result === "string" ? result : result.text;
    expect(text).toContain("not configured");
  });
});

describe("/thesis command", () => {
  it("shows the last 6 history snapshots when history exists", async () => {
    h.queryRowsMock.mockResolvedValueOnce([
      { ticker: "NVDA", bull_case: "Strong demand", bear_case: "Valuation risk", confidence: 8, key_drivers: ["GPU demand"], week_of: "2026-06-29" },
      { ticker: "NVDA", bull_case: "Solid quarter", bear_case: "Margin pressure", confidence: 7, key_drivers: [], week_of: "2026-06-22" },
    ]);

    const result = await h.handlers.get("thesis")!(ctx("/thesis NVDA"));
    const text = typeof result === "string" ? result : result.text;

    expect(text).toContain("2026-06-29");
    expect(text).toContain("2026-06-22");
    expect(text).toContain("Strong demand");
  });

  it("falls back to the latest ticker_theses snapshot when history is empty (regression guard)", async () => {
    h.queryRowsMock
      .mockResolvedValueOnce([]) // ticker_thesis_history — empty
      .mockResolvedValueOnce([
        { ticker: "NVDA", bull_case: "Strong demand", bear_case: "Valuation risk", confidence: 8, key_drivers: ["GPU demand"], updated_at: "2026-07-01T00:00:00Z" },
      ]); // ticker_theses fallback

    const result = await h.handlers.get("thesis")!(ctx("/thesis NVDA"));
    const text = typeof result === "string" ? result : result.text;

    // This is the exact pre-existing behavior — must not regress to "no data"
    // just because the new history table is empty.
    expect(text).toContain("Strong demand");
    expect(text).toContain("Confidence");
    expect(h.queryRowsMock).toHaveBeenNthCalledWith(1, "ticker_thesis_history", expect.stringContaining("ticker=eq.NVDA"));
    expect(h.queryRowsMock).toHaveBeenNthCalledWith(2, "ticker_theses", expect.stringContaining("ticker=eq.NVDA"));
  });

  it("shows 'no snapshot yet' when neither history nor ticker_theses has data", async () => {
    h.queryRowsMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const result = await h.handlers.get("thesis")!(ctx("/thesis NVDA"));
    const text = typeof result === "string" ? result : result.text;
    expect(text).toContain("No thesis snapshot");
  });

  it("no-ticker mode is unaffected by the history table (top-5 by confidence)", async () => {
    h.queryRowsMock.mockResolvedValueOnce([
      { ticker: "NVDA", bull_case: "b", bear_case: "b", confidence: 9, key_drivers: [] },
    ]);
    const result = await h.handlers.get("thesis")!(ctx("/thesis"));
    const text = typeof result === "string" ? result : result.text;
    expect(text).toContain("Top Thesis Snapshots");
    expect(h.queryRowsMock).toHaveBeenCalledWith("ticker_theses", expect.stringContaining("order=confidence.desc"));
  });
});

describe("/delivery command", () => {
  it("shows configured copies without exposing the Slack webhook", async () => {
    h.getUserPreferencesMock.mockResolvedValueOnce({
      chat_id: 1,
      delivery_email: "analyst@example.com",
      slack_webhook_url: "https://hooks.slack.com/services/T/B/secret",
    });

    const result = await h.handlers.get("delivery")!(ctx("/delivery"));
    const text = typeof result === "string" ? result : result.text;

    expect(text).toContain("a***@example.com");
    expect(text).toContain("Slack: Configured");
    expect(text).not.toContain("secret");
  });

  it("rejects non-Slack webhook hosts", async () => {
    const result = await h.handlers.get("delivery")!(
      ctx("/delivery slack https://example.com/services/T/B/secret")
    );
    const text = typeof result === "string" ? result : result.text;

    expect(text).toContain("hooks.slack.com");
    expect(h.upsertUserPreferencesMock).not.toHaveBeenCalled();
  });
});

describe("/watch command", () => {
  it("shows usage when no active watches exist", async () => {
    h.queryRowsMock.mockResolvedValueOnce([]);
    const result = await h.handlers.get("watch")!(ctx("/watch"));
    const text = typeof result === "string" ? result : result.text;
    expect(text).toContain("No active price watches");
    expect(text).toContain("Commands");
  });

  it("lists active watches for /watch list", async () => {
    h.queryRowsMock.mockResolvedValueOnce([
      { id: 1, chat_id: 1, ticker: "NVDA", threshold: 130, direction: "above" },
      { id: 2, chat_id: 1, ticker: "TSLA", threshold: 200, direction: "below" },
    ]);
    const result = await h.handlers.get("watch")!(ctx("/watch list"));
    const text = typeof result === "string" ? result : result.text;
    expect(text).toContain("NVDA");
    expect(text).toContain("TSLA");
    expect(h.queryRowsMock).toHaveBeenCalledWith("price_watches", expect.stringContaining("chat_id=eq.1"));
  });

  it("sets a watch with direction 'above' when the threshold is above the current price", async () => {
    h.fetchStockPricesMock.mockResolvedValueOnce(new Map([["NVDA", { ticker: "NVDA", price: 120, change: 0, changePercent: 0, previousClose: 120 }]]));
    const result = await h.handlers.get("watch")!(ctx("/watch NVDA 130"));
    const text = typeof result === "string" ? result : result.text;
    expect(text).toContain("NVDA");
    expect(text).toContain("130");
    expect(h.upsertPriceWatchMock).toHaveBeenCalledWith({ chat_id: 1, ticker: "NVDA", threshold: 130, direction: "above" });
  });

  it("sets a watch with direction 'below' when the threshold is below the current price", async () => {
    h.fetchStockPricesMock.mockResolvedValueOnce(new Map([["TSLA", { ticker: "TSLA", price: 220, change: 0, changePercent: 0, previousClose: 220 }]]));
    await h.handlers.get("watch")!(ctx("/watch TSLA 200"));
    expect(h.upsertPriceWatchMock).toHaveBeenCalledWith({ chat_id: 1, ticker: "TSLA", threshold: 200, direction: "below" });
  });

  it("fails closed when the current price can't be fetched, without storing a watch", async () => {
    h.fetchStockPricesMock.mockResolvedValueOnce(new Map());
    const result = await h.handlers.get("watch")!(ctx("/watch ZZZZ 130"));
    const text = typeof result === "string" ? result : result.text;
    expect(text).toContain("Could not fetch a price");
    expect(h.upsertPriceWatchMock).not.toHaveBeenCalled();
  });

  it.each(["abc", "-5", "0"])("rejects an invalid price '%s' without calling Supabase", async (badPrice) => {
    const result = await h.handlers.get("watch")!(ctx(`/watch NVDA ${badPrice}`));
    const text = typeof result === "string" ? result : result.text;
    expect(text).toContain("positive number");
    expect(h.upsertPriceWatchMock).not.toHaveBeenCalled();
    expect(h.fetchStockPricesMock).not.toHaveBeenCalled();
  });

  it("shows a usage error when a ticker is given with no price or 'off'", async () => {
    const result = await h.handlers.get("watch")!(ctx("/watch NVDA"));
    const text = typeof result === "string" ? result : result.text;
    expect(text).toContain("price");
  });

  it("clears a watch with /watch TICKER off", async () => {
    const result = await h.handlers.get("watch")!(ctx("/watch NVDA off"));
    const text = typeof result === "string" ? result : result.text;
    expect(text).toContain("Cleared");
    expect(h.deletePriceWatchMock).toHaveBeenCalledWith(1, "NVDA");
  });

  it("re-setting an existing watch upserts with the new threshold instead of duplicating", async () => {
    h.fetchStockPricesMock.mockResolvedValue(new Map([["NVDA", { ticker: "NVDA", price: 140, change: 0, changePercent: 0, previousClose: 140 }]]));
    await h.handlers.get("watch")!(ctx("/watch NVDA 130"));
    await h.handlers.get("watch")!(ctx("/watch NVDA 150"));
    expect(h.upsertPriceWatchMock).toHaveBeenCalledTimes(2);
    // price is 140 both times: threshold 130 < 140 → "below"; threshold 150 >= 140 → "above"
    expect(h.upsertPriceWatchMock).toHaveBeenLastCalledWith({ chat_id: 1, ticker: "NVDA", threshold: 150, direction: "above" });
  });

  it("shows a not-configured message when Supabase is unavailable", async () => {
    vi.doMock("./utils/supabase", () => ({ supabase: { isConfigured: () => false } }));
    vi.resetModules();
    const { registerDigestCommands: register2 } = await import("./index");
    h.handlers.clear();
    register2();
    const result = await h.handlers.get("watch")!(ctx("/watch NVDA 130"));
    const text = typeof result === "string" ? result : result.text;
    expect(text).toContain("not configured");
  });
});
