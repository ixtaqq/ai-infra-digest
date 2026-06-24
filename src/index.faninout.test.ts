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
// Supabase reports "not configured" so persistence/alert branches are skipped.
vi.mock("./utils/supabase", () => ({ supabase: { isConfigured: () => false } }));
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
