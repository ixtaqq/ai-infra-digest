import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneratedDigest } from "./types";

const h = vi.hoisted(() => ({
  generateDigest: vi.fn(),
  deliverDigest: vi.fn(),
  persistDigestMetrics: vi.fn(),
  createDigestPublication: vi.fn(),
  getDigestPublication: vi.fn(),
  isConfigured: vi.fn(),
  claimUserDelivery: vi.fn(),
  logUserDelivery: vi.fn(),
  wasUserDeliveredToday: vi.fn().mockResolvedValue(true),
}));

vi.mock("../config", () => ({
  config: { telegram: { chatId: "1" } },
}));
vi.mock("./generate", () => ({ generateDigest: h.generateDigest }));
vi.mock("../delivery/deliver", () => ({ deliverDigest: h.deliverDigest }));
vi.mock("./persist", () => ({ persistDigestMetrics: h.persistDigestMetrics }));
vi.mock("../utils/supabase", () => ({
  supabase: {
    isConfigured: h.isConfigured,
    createDigestPublication: h.createDigestPublication,
    getDigestPublication: h.getDigestPublication,
    claimUserDelivery: h.claimUserDelivery,
    logUserDelivery: h.logUserDelivery,
    wasUserDeliveredToday: h.wasUserDeliveredToday,
  },
}));
vi.mock("../sender/telegram", () => ({ sendValidationFollowUp: vi.fn() }));
vi.mock("../utils/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

import { runPipeline } from "./run";

const generated = {
  runDate: "2026-08-19",
  startTime: 1,
  formattedMessage: "digest",
  digest: {
    articles: [],
    topStocks: [],
    marketOutlook: "Neutral",
    summary: "Summary",
    categories: {},
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    batchesRun: 0,
  },
  articlesCollected: 0,
  feedStatuses: [],
  secExtracts: [],
  earningsAnalyses: [],
  stockPrices: new Map(),
  activeWatches: [],
  capabilities: Object.fromEntries(["primaryAi", "fallbackAi", "embeddings", "earnings", "supabase", "slack", "email"].map(key => [key, { state: "enabled", detail: "fixture" }])),
} as unknown as GeneratedDigest;

beforeEach(() => {
  h.generateDigest.mockReset().mockResolvedValue(generated);
  h.deliverDigest.mockReset().mockImplementation(async (_edition, _chat, _prefs, _date, finalize) => {
    const result = { success: true };
    if (finalize) await finalize(result);
    return result;
  });
  h.persistDigestMetrics.mockReset().mockResolvedValue(new Map());
  h.createDigestPublication.mockReset().mockResolvedValue(17);
  h.getDigestPublication.mockReset().mockImplementation(async () => ({
    id: 17,
    publication_date: "2026-08-19",
    payload: {
      schemaVersion: 1,
      promptVersion: "2026-08-19.indexed-source-v1",
      analysisSchemaVersion: 2,
      runDate: "2026-08-19",
      formattedMessage: "digest",
      digest: generated.digest,
      articlesCollected: 0,
      feedStatuses: [],
      secExtracts: [],
      earningsAnalyses: [],
      stockPrices: [],
      capabilities: generated.capabilities,
    },
    article_ids: {},
  }));
  h.isConfigured.mockReset().mockReturnValue(true);
  h.claimUserDelivery.mockReset().mockResolvedValue(true);
  h.logUserDelivery.mockReset().mockResolvedValue(true);
  delete generated.publicationId;
});

describe("editorial pipeline publication", () => {
  it("persists and publishes before delivery", async () => {
    await expect(runPipeline()).resolves.toBe(true);

    expect(h.persistDigestMetrics).toHaveBeenCalledWith(generated, "running");
    expect(h.createDigestPublication).toHaveBeenCalledWith(
      "2026-08-19",
      expect.objectContaining({ schemaVersion: 1, formattedMessage: "digest" }),
      new Map()
    );
    expect(h.getDigestPublication).toHaveBeenCalledWith("2026-08-19");
    expect(h.claimUserDelivery).toHaveBeenCalledWith(1, "2026-08-19");
    expect(h.logUserDelivery).toHaveBeenCalledWith(
      1,
      "2026-08-19",
      "success",
      undefined,
      17
    );
    expect(h.persistDigestMetrics.mock.invocationCallOrder[0]).toBeLessThan(
      h.createDigestPublication.mock.invocationCallOrder[0]
    );
    expect(h.createDigestPublication.mock.invocationCallOrder[0]).toBeLessThan(
      h.deliverDigest.mock.invocationCallOrder[0]
    );
  });

  it("does not double-send the default chat when another run owns its delivery", async () => {
    h.claimUserDelivery.mockResolvedValueOnce(false);

    await expect(runPipeline()).resolves.toBe(true);

    expect(h.deliverDigest).not.toHaveBeenCalled();
    expect(h.logUserDelivery).not.toHaveBeenCalled();
  });

  it("does not deliver an edition that failed canonical publication", async () => {
    h.createDigestPublication.mockResolvedValueOnce(null);

    await expect(runPipeline()).resolves.toBe(false);

    expect(h.deliverDigest).not.toHaveBeenCalled();
  });

  it("withholds publication when article persistence is incomplete", async () => {
    h.generateDigest.mockResolvedValueOnce({
      ...generated,
      digest: {
        ...generated.digest,
        articles: [{ url: "https://example.com/story" }],
      },
    });
    h.persistDigestMetrics.mockResolvedValueOnce(new Map());

    await expect(runPipeline()).resolves.toBe(false);

    expect(h.createDigestPublication).not.toHaveBeenCalled();
    expect(h.deliverDigest).not.toHaveBeenCalled();
  });

  it("delivers the stored canonical payload when a same-day rerun conflicts", async () => {
    h.getDigestPublication.mockResolvedValueOnce({
      id: 17,
      publication_date: "2026-08-19",
      payload: {
        schemaVersion: 1,
        promptVersion: "2026-08-19.indexed-source-v1",
        analysisSchemaVersion: 2,
        runDate: "2026-08-19",
        formattedMessage: "first immutable edition",
        digest: generated.digest,
        articlesCollected: 1,
        feedStatuses: [],
        secExtracts: [],
        earningsAnalyses: [],
        stockPrices: [],
        capabilities: generated.capabilities,
      },
      article_ids: { canonical: 11 },
    });

    await expect(runPipeline()).resolves.toBe(true);

    expect(h.deliverDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        publicationId: 17,
        formattedMessage: "first immutable edition",
      }), undefined, undefined, undefined, expect.any(Function)
    );
  });
});
