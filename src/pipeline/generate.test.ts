import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DigestResult, ProcessedArticle } from "../processor/ai";

const h = vi.hoisted(() => ({
  collectArticles: vi.fn(),
  processArticles: vi.fn(),
  sendDigestMessage: vi.fn(),
  generateEmbeddings: vi.fn(),
  embedSeeds: vi.fn(),
  generateBearCases: vi.fn(),
  collectSECFilings: vi.fn(),
  collectEarningsTranscripts: vi.fn(),
  fetchStockPrices: vi.fn(),
  formatDigestTelegram: vi.fn(),
  deduplicateArticles: vi.fn(),
  buildCorroborationMap: vi.fn(),
  getCached: vi.fn(),
  setCached: vi.fn(),
  isMonthlyBudgetExceeded: vi.fn(),
  getCapabilityReport: vi.fn(),
  formatCapabilityReport: vi.fn(),
  degradedCapabilities: vi.fn(),
  writeDerivedMetrics: vi.fn(),
  queryRecentDerivedMetrics: vi.fn(),
  getTrustScores: vi.fn(),
  isConfigured: vi.fn(),
  queryRows: vi.fn(),
  getAllActiveUsers: vi.fn(),
  getAllPriceWatches: vi.fn(),
  claimHighImpactAlert: vi.fn(),
  logHighImpactAlert: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("../config", () => ({
  config: {
    ai: {
      provider: "groq",
      apiKey: "test-key",
      model: "model",
      fastModel: "fast-model",
      baseUrl: "https://example.com",
      embeddingApiKey: "",
      embeddingModel: "embedding-model",
    },
    telegram: { botToken: "telegram-token", chatId: "1" },
    app: {
      timezone: "UTC",
      cacheDir: ".",
      maxArticlesPerSource: 5,
      budgetDailyUsd: 0.5,
      budgetMonthlyUsd: 5,
      roicAiApiKey: undefined,
    },
  },
}));
vi.mock("../collector/rss", () => ({
  collectArticles: h.collectArticles,
  skipFeed: vi.fn(),
  resetSkippedFeeds: vi.fn(),
}));
vi.mock("../processor/ai", () => ({
  processArticles: h.processArticles,
  NEWS_CATEGORIES: ["Chips & GPUs"],
  isSECFilingArticle: vi.fn(() => false),
}));
vi.mock("../collector/sec", () => ({
  collectSECFilings: h.collectSECFilings,
  getTopFilings: vi.fn(() => []),
}));
vi.mock("../processor/sec", () => ({ analyzeSECFilings: vi.fn() }));
vi.mock("../collector/earnings", () => ({ collectEarningsTranscripts: h.collectEarningsTranscripts }));
vi.mock("../processor/earnings", () => ({ analyzeEarningsTranscripts: vi.fn() }));
vi.mock("../processor/embeddings", () => ({ generateEmbeddings: h.generateEmbeddings }));
vi.mock("../processor/relevance", () => ({
  embedSeeds: h.embedSeeds,
  passesSemanticGate: vi.fn(() => true),
}));
vi.mock("../processor/bear-cases", () => ({ generateBearCases: h.generateBearCases }));
vi.mock("../utils/novelty", () => ({ flagRehashes: vi.fn() }));
vi.mock("../utils/grounding", () => ({ attachGroundingNotes: vi.fn() }));
vi.mock("../utils/stocks", () => ({ fetchStockPrices: h.fetchStockPrices }));
vi.mock("../formatter/telegram", () => ({ formatDigestTelegram: h.formatDigestTelegram }));
vi.mock("../utils/dedup", () => ({
  deduplicateArticles: h.deduplicateArticles,
  buildCorroborationMap: h.buildCorroborationMap,
}));
vi.mock("../utils/ai-cache", () => ({ getCached: h.getCached, setCached: h.setCached }));
vi.mock("../utils/budget", () => ({ isMonthlyBudgetExceeded: h.isMonthlyBudgetExceeded }));
vi.mock("../utils/capabilities", () => ({
  getCapabilityReport: h.getCapabilityReport,
  formatCapabilityReport: h.formatCapabilityReport,
  degradedCapabilities: h.degradedCapabilities,
}));
vi.mock("../utils/derived-metrics", () => ({
  writeDerivedMetrics: h.writeDerivedMetrics,
  queryRecentDerivedMetrics: h.queryRecentDerivedMetrics,
}));
vi.mock("../utils/metrics", () => ({
  emitError: vi.fn(),
  emitFeedFetch: vi.fn(),
  emitStockFetch: vi.fn(),
}));
vi.mock("../utils/retry", () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  tryStage: vi.fn(async (fn: () => Promise<unknown>) => {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }),
}));
vi.mock("../utils/supabase", () => ({
  supabase: {
    isConfigured: h.isConfigured,
    queryRows: h.queryRows,
    getAllActiveUsers: h.getAllActiveUsers,
    getAllPriceWatches: h.getAllPriceWatches,
    claimHighImpactAlert: h.claimHighImpactAlert,
    logHighImpactAlert: h.logHighImpactAlert,
  },
}));
vi.mock("../utils/trust-scores", () => ({ getTrustScores: h.getTrustScores }));
vi.mock("node-telegram-bot-api", () => ({
  default: class MockTelegramBot {
    sendMessage(...args: unknown[]) {
      return h.sendMessage(...args);
    }
  },
}));

import { buildWhatChanged, generateDigest, sendHighImpactAlerts } from "./generate";

function article(overrides: Partial<ProcessedArticle> = {}): ProcessedArticle {
  return {
    title: "GPU infrastructure update",
    url: "https://example.com/article",
    source: "Example",
    summary: "A useful summary",
    impact: "Bullish",
    impactScore: 8,
    affectedStocks: ["NVDA"],
    reason: "Reason",
    category: "Chips & GPUs",
    relevanceScore: 9,
    ...overrides,
  };
}

function digestOf(articles: ProcessedArticle[]): DigestResult {
  return {
    articles,
    topStocks: [],
    marketOutlook: "outlook",
    summary: "summary",
    categories: { "Chips & GPUs": articles } as DigestResult["categories"],
    usage: { totalTokens: 1, promptTokens: 1, completionTokens: 0 },
    batchesRun: 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.collectArticles.mockResolvedValue({
    articles: [{ title: "GPU input", url: "https://example.com/input", source: "Example", contentSnippet: "GPU" }],
    feedStatuses: [],
  });
  h.processArticles.mockResolvedValue(digestOf([article({ impactScore: 5 })]));
  h.sendDigestMessage.mockResolvedValue({ success: true });
  h.generateEmbeddings.mockResolvedValue(new Map());
  h.embedSeeds.mockResolvedValue([]);
  h.generateBearCases.mockResolvedValue({ bearCases: new Map() });
  h.collectSECFilings.mockResolvedValue({ newFilings: [] });
  h.collectEarningsTranscripts.mockResolvedValue({ transcripts: [] });
  h.fetchStockPrices.mockResolvedValue(new Map());
  h.formatDigestTelegram.mockReturnValue("DIGEST");
  h.deduplicateArticles.mockImplementation((articles: unknown[]) => articles);
  h.buildCorroborationMap.mockReturnValue(new Map());
  h.getCached.mockReturnValue(null);
  h.isMonthlyBudgetExceeded.mockResolvedValue(false);
  h.getCapabilityReport.mockReturnValue({ embeddings: { state: "disabled", detail: "no embedding key" } });
  h.formatCapabilityReport.mockReturnValue("embeddings=disabled");
  h.degradedCapabilities.mockReturnValue([]);
  h.writeDerivedMetrics.mockResolvedValue(undefined);
  h.queryRecentDerivedMetrics.mockResolvedValue([]);
  h.getTrustScores.mockResolvedValue({ source: new Map(), sector: new Map() });
  h.isConfigured.mockReturnValue(true);
  h.queryRows.mockResolvedValue([]);
  h.getAllActiveUsers.mockResolvedValue([
    { chat_id: 123, alerts_enabled: true, alerts_min_score: 8 },
  ]);
  h.claimHighImpactAlert.mockResolvedValue(true);
  h.logHighImpactAlert.mockResolvedValue(true);
  h.getAllPriceWatches.mockResolvedValue([]);
  h.sendMessage.mockResolvedValue({ message_id: 1 });
});

describe("generateDigest pipeline safety", () => {
  it("dispatches high-impact alerts only after relevance filtering", async () => {
    const lowRelevance = article({
      title: "Off-topic high impact",
      url: "https://example.com/off-topic",
      impactScore: 10,
      relevanceScore: 2,
    });
    const relevant = article({
      title: "Relevant high impact",
      url: "https://example.com/relevant",
      impactScore: 8,
      relevanceScore: 8,
    });
    h.processArticles.mockResolvedValue(digestOf([lowRelevance, relevant]));

    const generated = await generateDigest();

    expect(generated?.digest.articles.map((item) => item.title)).toEqual(["Relevant high impact"]);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage.mock.calls[0][1]).toContain("Relevant high impact");
    expect(h.sendMessage.mock.calls[0][1]).not.toContain("Off-topic high impact");
  });

  it("keeps the lexical corroboration map when no embedding vectors are available", async () => {
    await generateDigest();

    expect(h.generateEmbeddings).toHaveBeenCalledTimes(1);
    expect(h.buildCorroborationMap).toHaveBeenCalledTimes(1);
  });

  it("does not label seven observed dates as a week-over-week delta", async () => {
    h.queryRecentDerivedMetrics.mockResolvedValue(
      Array.from({ length: 7 }, (_, index) => ({
        date: `2026-07-0${index + 1}`,
        entity_type: "ticker",
        entity: "NVDA",
        mention_count: index === 6 ? 10 : 1,
        avg_impact_score: 7,
      }))
    );

    await expect(buildWhatChanged()).resolves.toBeUndefined();
  });

  it("computes a week-over-week delta only after eight observations", async () => {
    h.queryRecentDerivedMetrics.mockResolvedValue(
      Array.from({ length: 8 }, (_, index) => ({
        date: `2026-07-${String(index + 1).padStart(2, "0")}`,
        entity_type: "ticker",
        entity: "NVDA",
        mention_count: index === 7 ? 10 : 5,
        avg_impact_score: 7,
      }))
    );

    await expect(buildWhatChanged()).resolves.toContain("+100% WoW");
  });
});

describe("sendHighImpactAlerts", () => {
  it("clamps scores and escapes dynamic HTML fields", async () => {
    const unsafe = article({
      title: `<alert> & "quoted"`,
      summary: `<script>alert('x')</script>\nsecond line`,
      category: "<Power & Utilities>" as ProcessedArticle["category"],
      affectedStocks: ["NVDA&", "<AMD>", 42] as unknown as string[],
      impact: "<b>Injected</b>" as ProcessedArticle["impact"],
      impactScore: 99,
      url: `https://example.com/article?x=1&y="two"`,
    });
    h.getAllActiveUsers.mockResolvedValue([
      { chat_id: 123, alerts_enabled: true, alerts_min_score: "invalid" },
    ]);

    await sendHighImpactAlerts([unsafe]);

    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const text = h.sendMessage.mock.calls[0][1] as string;
    expect(text).toContain("Impact: Neutral (10/10)");
    expect(text).toContain("&lt;alert&gt; &amp; &quot;quoted&quot;");
    expect(text).toContain("&lt;Power &amp; Utilities&gt;");
    expect(text).toContain("NVDA&amp;, &lt;AMD&gt;");
    expect(text).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(text).toContain("x=1&amp;y=&quot;two&quot;");
    expect(text).not.toContain("<script>");
  });

  it("clamps user thresholds and rejects invalid chat IDs", async () => {
    h.getAllActiveUsers.mockResolvedValue([
      { chat_id: 123, alerts_enabled: true, alerts_min_score: 99 },
      { chat_id: 1.5, alerts_enabled: true, alerts_min_score: 8 },
      { chat_id: 456, alerts_enabled: true, alerts_min_score: 8 },
    ]);

    await sendHighImpactAlerts([article({ impactScore: 8 })]);

    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage.mock.calls[0][0]).toBe(456);
  });

  it("suppresses an alert when the user/article claim already exists", async () => {
    h.claimHighImpactAlert.mockResolvedValue(false);

    await sendHighImpactAlerts([article({ impactScore: 9 })]);

    expect(h.claimHighImpactAlert).toHaveBeenCalledTimes(1);
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.logHighImpactAlert).not.toHaveBeenCalled();
  });

  it("releases a claimed alert for retry when Telegram sending fails", async () => {
    h.sendMessage.mockRejectedValueOnce(new Error("telegram unavailable"));

    await sendHighImpactAlerts([article({ impactScore: 9 })]);

    expect(h.logHighImpactAlert).toHaveBeenCalledWith(
      123,
      expect.stringMatching(/^[0-9a-f]{64}$/),
      "failed",
      "telegram unavailable"
    );
  });
});
