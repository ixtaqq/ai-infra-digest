import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getAllActiveUsers: vi.fn(),
  wasUserDeliveredToday: vi.fn(),
  getDigestPublication: vi.fn(),
  getAllPriceWatches: vi.fn(),
  generateDigest: vi.fn(),
  deliverDigest: vi.fn(),
  persistDigestMetrics: vi.fn(),
  setTelegramMode: vi.fn(),
}));

vi.mock("./utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./utils/metrics", () => ({ flushMetrics: vi.fn() }));
vi.mock("./config", () => ({ config: { app: { timezone: "UTC" } } }));
vi.mock("./utils/supabase", () => ({
  supabase: {
    isConfigured: () => true,
    getAllActiveUsers: h.getAllActiveUsers,
    wasUserDeliveredToday: h.wasUserDeliveredToday,
    getDigestPublication: h.getDigestPublication,
    getAllPriceWatches: h.getAllPriceWatches,
  },
}));
vi.mock("./delivery/deliver", () => ({ deliverDigest: h.deliverDigest }));
vi.mock("./pipeline/generate", () => ({ generateDigest: h.generateDigest }));
vi.mock("./pipeline/persist", () => ({ persistDigestMetrics: h.persistDigestMetrics }));
vi.mock("./sender/telegram", () => ({
  sendValidationFollowUp: vi.fn(),
  setTelegramMode: h.setTelegramMode,
}));

import { schedulerMain } from "./scheduler";

const payload = {
  schemaVersion: 1,
  promptVersion: "2026-08-19.indexed-source-v1",
  analysisSchemaVersion: 2,
  runDate: "2026-08-19",
  formattedMessage: "canonical digest",
  digest: {
    articles: [],
    topStocks: [],
    marketOutlook: "Neutral",
    summary: "Summary",
    categories: {},
    usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    batchesRun: 1,
  },
  articlesCollected: 1,
  feedStatuses: [],
  secExtracts: [],
  earningsAnalyses: [],
  stockPrices: [],
  capabilities: { rss: { state: "available", detail: "ok" } },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-19T12:00:00Z"));
  h.getAllActiveUsers.mockReset().mockResolvedValue([
    { chat_id: 101, preferred_time: "00:00", timezone: "UTC" },
  ]);
  h.wasUserDeliveredToday.mockReset().mockResolvedValue(false);
  h.getDigestPublication.mockReset().mockResolvedValue({
    id: 17,
    publication_date: "2026-08-19",
    schema_version: 1,
    payload,
    article_ids: {},
  });
  h.getAllPriceWatches.mockReset().mockResolvedValue([]);
  h.generateDigest.mockReset();
  h.deliverDigest.mockReset().mockResolvedValue({ success: true });
  h.persistDigestMetrics.mockReset();
  h.setTelegramMode.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduled publication delivery", () => {
  it("loads canonical content and never invokes generation or persistence", async () => {
    await schedulerMain();

    expect(h.setTelegramMode).toHaveBeenCalledWith("send-only");
    expect(h.getDigestPublication).toHaveBeenCalledTimes(1);
    expect(h.getDigestPublication).toHaveBeenCalledWith("2026-08-19");
    expect(h.getAllPriceWatches).toHaveBeenCalledTimes(1);
    expect(h.deliverDigest).toHaveBeenCalledWith(
      expect.objectContaining({ publicationId: 17, formattedMessage: "canonical digest" }),
      101,
      expect.objectContaining({ chat_id: 101 }),
      expect.any(String)
    );
    expect(h.generateDigest).not.toHaveBeenCalled();
    expect(h.persistDigestMetrics).not.toHaveBeenCalled();
  });

  it("keeps the editorial date separate from a user's local delivery slot", async () => {
    vi.setSystemTime(new Date("2026-08-19T01:00:00Z"));
    h.getAllActiveUsers.mockResolvedValueOnce([
      { chat_id: 101, preferred_time: "00:00", timezone: "America/Los_Angeles" },
    ]);

    await schedulerMain();

    expect(h.getDigestPublication).toHaveBeenCalledWith("2026-08-19");
    expect(h.deliverDigest).toHaveBeenCalledWith(
      expect.objectContaining({ publicationId: 17 }),
      101,
      expect.any(Object),
      "2026-08-18"
    );
  });

  it("waits safely when no canonical publication is ready", async () => {
    h.getDigestPublication.mockResolvedValueOnce(null);

    await schedulerMain();

    expect(h.deliverDigest).not.toHaveBeenCalled();
    expect(h.generateDigest).not.toHaveBeenCalled();
  });
});
