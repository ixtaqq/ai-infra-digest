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
  claimUserDelivery: vi.fn(),
  logUserDelivery: vi.fn(),
  config: { app: { timezone: "UTC" }, telegram: { chatId: "" } },
}));

vi.mock("./utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./utils/metrics", () => ({ flushMetrics: vi.fn() }));
vi.mock("./config", () => ({ config: h.config }));
vi.mock("./utils/supabase", () => ({
  supabase: {
    isConfigured: () => true,
    getAllActiveUsers: h.getAllActiveUsers,
    wasUserDeliveredToday: h.wasUserDeliveredToday,
    getDigestPublication: h.getDigestPublication,
    getAllPriceWatches: h.getAllPriceWatches,
    claimUserDelivery: h.claimUserDelivery,
    logUserDelivery: h.logUserDelivery,
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
  capabilities: Object.fromEntries(["primaryAi", "fallbackAi", "embeddings", "earnings", "supabase", "slack", "email"].map(key => [key, { state: "enabled", detail: "fixture" }])),
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
  h.config.telegram.chatId = "";
  h.claimUserDelivery.mockReset().mockResolvedValue(true);
  h.logUserDelivery.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduled publication delivery", () => {
  it("holds the default channel until 08:00, then delivers with its durable claim", async () => {
    h.config.telegram.chatId = "-100";
    h.getAllActiveUsers.mockResolvedValue([]);
    vi.setSystemTime(new Date("2026-08-19T07:59:00Z"));
    await schedulerMain();
    expect(h.deliverDigest).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-08-19T08:00:00Z"));
    await schedulerMain();
    expect(h.claimUserDelivery).toHaveBeenCalledWith(-100, "2026-08-19");
    expect(h.deliverDigest).toHaveBeenCalledWith(
      expect.objectContaining({ publicationId: 17 }), undefined, undefined, undefined, expect.any(Function)
    );
  });

  it("does not replay an uncertain default-channel claim", async () => {
    h.config.telegram.chatId = "-100";
    h.getAllActiveUsers.mockResolvedValue([]);
    h.claimUserDelivery.mockResolvedValue(false);
    await expect(schedulerMain()).rejects.toThrow("1 failed");
    expect(h.deliverDigest).not.toHaveBeenCalled();
  });

  it("catches up when publication appears, then skips a successful slot", async () => {
    h.getDigestPublication.mockResolvedValueOnce(null);
    await expect(schedulerMain()).rejects.toThrow("1 failed");
    expect(h.deliverDigest).not.toHaveBeenCalled();
    await schedulerMain();
    expect(h.deliverDigest).toHaveBeenCalledTimes(1);
    h.wasUserDeliveredToday.mockResolvedValue(true);
    await schedulerMain();
    expect(h.deliverDigest).toHaveBeenCalledTimes(1);
  });

  it("does not send twice when the default chat is also a due subscriber", async () => {
    h.config.telegram.chatId = "101";
    await schedulerMain();
    expect(h.deliverDigest).toHaveBeenCalledTimes(1);
    expect(h.claimUserDelivery).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed default-chat configuration instead of silently omitting it", async () => {
    h.config.telegram.chatId = "not-a-chat-id";
    await expect(schedulerMain()).rejects.toThrow("Invalid default delivery chat");
    expect(h.deliverDigest).not.toHaveBeenCalled();
  });

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

    await expect(schedulerMain()).rejects.toThrow("1 failed");

    expect(h.deliverDigest).not.toHaveBeenCalled();
    expect(h.generateDigest).not.toHaveBeenCalled();
  });
});

it("reports total delivery failure as a failed scheduler run", async () => {
  h.deliverDigest.mockResolvedValue({ success: false, error: "blocked" });
  await expect(schedulerMain()).rejects.toThrow("0 delivered, 1 failed");
});
it("rejects an empty nested digest before delivery can claim a slot", async () => {
  h.getDigestPublication.mockResolvedValue({ id: 17, payload: { ...payload, digest: {} } });
  await expect(schedulerMain()).rejects.toThrow("1 failed");
  expect(h.deliverDigest).not.toHaveBeenCalled();
});
