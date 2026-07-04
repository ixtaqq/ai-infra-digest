import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression guard for issue #1 (the fan-out fix): the expensive pipeline work
 * (RSS collect + AI process) must run ONCE per generation, even when the digest
 * is delivered to many users. The old design re-ran the whole pipeline per user.
 */

const h = vi.hoisted(() => ({
  collectArticles: vi.fn(),
  processArticles: vi.fn(),
  sendDigestMessage: vi.fn(),
  sendDigestMessageToUser: vi.fn(),
  fetchStockPrices: vi.fn(),
  isConfigured: vi.fn(),
  queryRows: vi.fn(),
  getAllPriceWatches: vi.fn(),
  deletePriceWatchesByIds: vi.fn(),
  claimUserDelivery: vi.fn(),
  logUserDelivery: vi.fn(),
  getAllActiveUsers: vi.fn(),
}));

vi.mock("./config", () => ({
  config: {
    ai: { provider: "groq", apiKey: "x", model: "m", fastModel: "f", baseUrl: "" },
    telegram: { botToken: "x", chatId: "1" },
    app: { timezone: "UTC", cacheDir: ".", maxArticlesPerSource: 5, roicAiApiKey: undefined },
  },
}));
vi.mock("./collector/rss", () => ({
  collectArticles: h.collectArticles,
  skipFeed: vi.fn(),
  resetSkippedFeeds: vi.fn(),
}));
vi.mock("./processor/ai", () => ({
  processArticles: h.processArticles,
  NEWS_CATEGORIES: ["Chips & GPUs"],
  isSECFilingArticle: () => false,
}));
vi.mock("./collector/sec", () => ({
  collectSECFilings: vi.fn(async () => ({ newFilings: [] })),
  getTopFilings: vi.fn(() => []),
}));
vi.mock("./processor/sec", () => ({ analyzeSECFilings: vi.fn(async () => ({ extracts: [] })) }));
vi.mock("./collector/earnings", () => ({ collectEarningsTranscripts: vi.fn(async () => ({ transcripts: [] })) }));
vi.mock("./processor/earnings", () => ({ analyzeEarningsTranscripts: vi.fn(async () => ({ analyses: [], totalTokens: 0 })) }));
vi.mock("./utils/stocks", () => ({ fetchStockPrices: h.fetchStockPrices }));
vi.mock("./formatter/telegram", () => ({ formatDigestTelegram: vi.fn(() => "DIGEST_MSG") }));
vi.mock("./utils/dedup", () => ({ deduplicateArticles: (a: unknown[]) => a, buildCorroborationMap: vi.fn(() => new Map()) }));
vi.mock("./utils/metrics", () => ({
  emitFeedFetch: vi.fn(), emitStockFetch: vi.fn(), emitDigestDelivery: vi.fn(), emitError: vi.fn(),
}));
vi.mock("./sender/telegram", () => ({
  sendDigestMessage: h.sendDigestMessage,
  sendDigestMessageToUser: h.sendDigestMessageToUser,
  sendValidationFollowUp: vi.fn(),
  startInteractiveBot: vi.fn(),
  registerCommand: vi.fn(),
}));
// Supabase reports "not configured" by default so persistence/alert branches
// are skipped — flipped to true in the price-watch tests below, which need it.
vi.mock("./utils/supabase", () => ({
  supabase: {
    isConfigured: h.isConfigured,
    queryRows: h.queryRows,
    getAllPriceWatches: h.getAllPriceWatches,
    deletePriceWatchesByIds: h.deletePriceWatchesByIds,
    claimUserDelivery: h.claimUserDelivery,
    logUserDelivery: h.logUserDelivery,
    getAllActiveUsers: h.getAllActiveUsers,
  },
}));
// Prevent filesystem cache from skipping the mocked processArticles call.
vi.mock("./utils/ai-cache", () => ({ getCached: vi.fn(() => null), setCached: vi.fn() }));

import { generateDigest, deliverDigest } from "./index";

const fakeDigest = {
  articles: [
    { title: "t", url: "u", source: "s", summary: "x", impact: "Bullish", impactScore: 8, affectedStocks: ["NVDA"], reason: "r", category: "Chips & GPUs" },
  ],
  topStocks: [],
  marketOutlook: "o",
  summary: "s",
  categories: { "Chips & GPUs": [] },
  usage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 },
  batchesRun: 1,
};

beforeEach(() => {
  h.collectArticles.mockReset().mockResolvedValue({
    articles: [{ title: "t", url: "u", source: "s", contentSnippet: "c" }],
    feedStatuses: [],
  });
  h.processArticles.mockReset().mockResolvedValue(fakeDigest);
  h.fetchStockPrices.mockReset().mockResolvedValue(new Map());
  h.sendDigestMessage.mockReset().mockResolvedValue({ success: true, messageId: 1 });
  h.sendDigestMessageToUser.mockReset().mockResolvedValue({ success: true, messageId: 2 });
  h.isConfigured.mockReset().mockReturnValue(false);
  h.queryRows.mockReset().mockResolvedValue([]);
  h.getAllPriceWatches.mockReset().mockResolvedValue([]);
  h.deletePriceWatchesByIds.mockReset().mockResolvedValue(true);
  h.claimUserDelivery.mockReset().mockResolvedValue(true);
  h.logUserDelivery.mockReset().mockResolvedValue(true);
  h.getAllActiveUsers.mockReset().mockResolvedValue([]);
});

describe("digest fan-out", () => {
  it("generates the digest once and reuses it across many user deliveries", async () => {
    const generated = await generateDigest();
    expect(generated).not.toBeNull();
    expect(h.collectArticles).toHaveBeenCalledTimes(1);
    expect(h.processArticles).toHaveBeenCalledTimes(1);

    // Fan out the SAME generated digest to three users.
    await deliverDigest(generated!, 101);
    await deliverDigest(generated!, 102);
    await deliverDigest(generated!, 103);

    // The expensive work must NOT have re-run during delivery.
    expect(h.collectArticles).toHaveBeenCalledTimes(1);
    expect(h.processArticles).toHaveBeenCalledTimes(1);

    // But each user received the digest.
    expect(h.sendDigestMessageToUser).toHaveBeenCalledTimes(3);
    expect(h.sendDigestMessageToUser).toHaveBeenCalledWith(101, "DIGEST_MSG");
    expect(h.sendDigestMessageToUser).toHaveBeenCalledWith(103, "DIGEST_MSG");
  });
});

describe("price watch check-and-notify", () => {
  it("sends one combined notification and deletes the watch once triggered", async () => {
    h.isConfigured.mockReturnValue(true);
    h.getAllPriceWatches.mockResolvedValue([
      { id: 1, chat_id: 101, ticker: "NVDA", threshold: 130, direction: "above" },
    ]);
    h.fetchStockPrices.mockResolvedValue(
      new Map([["NVDA", { ticker: "NVDA", price: 135, change: 5, changePercent: 3.8, previousClose: 130 }]])
    );

    const generated = await generateDigest();
    await deliverDigest(generated!, 101);

    // One send for the digest itself, one for the combined watch notification.
    expect(h.sendDigestMessageToUser).toHaveBeenCalledTimes(2);
    const watchCall = h.sendDigestMessageToUser.mock.calls.find(
      (c) => typeof c[1] === "string" && c[1].includes("Price Watch")
    );
    expect(watchCall).toBeDefined();
    expect(watchCall![1]).toContain("NVDA");
    expect(h.deletePriceWatchesByIds).toHaveBeenCalledWith([1]);
  });

  it("does not notify or delete when the watch hasn't triggered", async () => {
    h.isConfigured.mockReturnValue(true);
    h.getAllPriceWatches.mockResolvedValue([
      { id: 1, chat_id: 101, ticker: "NVDA", threshold: 130, direction: "above" },
    ]);
    h.fetchStockPrices.mockResolvedValue(
      new Map([["NVDA", { ticker: "NVDA", price: 125, change: -5, changePercent: -3.8, previousClose: 130 }]])
    );

    const generated = await generateDigest();
    await deliverDigest(generated!, 101);

    expect(h.sendDigestMessageToUser).toHaveBeenCalledTimes(1); // just the digest
    expect(h.deletePriceWatchesByIds).not.toHaveBeenCalled();
  });

  it("combines multiple triggered watches for the same user into a single message", async () => {
    h.isConfigured.mockReturnValue(true);
    h.getAllPriceWatches.mockResolvedValue([
      { id: 1, chat_id: 101, ticker: "NVDA", threshold: 130, direction: "above" },
      { id: 2, chat_id: 101, ticker: "TSLA", threshold: 200, direction: "below" },
    ]);
    h.fetchStockPrices.mockResolvedValue(
      new Map([
        ["NVDA", { ticker: "NVDA", price: 135, change: 5, changePercent: 3.8, previousClose: 130 }],
        ["TSLA", { ticker: "TSLA", price: 190, change: -10, changePercent: -5, previousClose: 200 }],
      ])
    );

    const generated = await generateDigest();
    await deliverDigest(generated!, 101);

    expect(h.sendDigestMessageToUser).toHaveBeenCalledTimes(2); // digest + ONE combined watch message
    expect(h.deletePriceWatchesByIds).toHaveBeenCalledWith([1, 2]);
  });

  it("skips watch checking entirely for the legacy default-chat path (no targetChatId)", async () => {
    h.isConfigured.mockReturnValue(true);
    h.getAllPriceWatches.mockResolvedValue([
      { id: 1, chat_id: 101, ticker: "NVDA", threshold: 130, direction: "above" },
    ]);
    h.fetchStockPrices.mockResolvedValue(
      new Map([["NVDA", { ticker: "NVDA", price: 135, change: 5, changePercent: 3.8, previousClose: 130 }]])
    );

    const generated = await generateDigest();
    await deliverDigest(generated!); // no targetChatId

    expect(h.sendDigestMessageToUser).not.toHaveBeenCalled();
    expect(h.deletePriceWatchesByIds).not.toHaveBeenCalled();
  });

  it("does not delete the watch when the notification send fails", async () => {
    h.isConfigured.mockReturnValue(true);
    h.getAllPriceWatches.mockResolvedValue([
      { id: 1, chat_id: 101, ticker: "NVDA", threshold: 130, direction: "above" },
    ]);
    h.fetchStockPrices.mockResolvedValue(
      new Map([["NVDA", { ticker: "NVDA", price: 135, change: 5, changePercent: 3.8, previousClose: 130 }]])
    );
    h.sendDigestMessageToUser
      .mockResolvedValueOnce({ success: true, messageId: 1 }) // the digest send
      .mockResolvedValueOnce({ success: false, error: "boom" }); // the watch notification send

    const generated = await generateDigest();
    await deliverDigest(generated!, 101);

    expect(h.deletePriceWatchesByIds).not.toHaveBeenCalled();
  });

  it("prepends watched tickers so they survive fetchStockPrices' 25-ticker cap", async () => {
    h.isConfigured.mockReturnValue(true);
    h.getAllPriceWatches.mockResolvedValue([
      { id: 1, chat_id: 101, ticker: "ZZZZ", threshold: 10, direction: "above" },
    ]);
    h.processArticles.mockResolvedValueOnce({
      ...fakeDigest,
      articles: Array.from({ length: 30 }, (_, i) => ({
        ...fakeDigest.articles[0],
        url: `u${i}`,
        affectedStocks: [`T${i}`],
      })),
    });

    await generateDigest();

    const tickersPassed = h.fetchStockPrices.mock.calls[0][0] as string[];
    expect(tickersPassed[0]).toBe("ZZZZ");
  });
});
