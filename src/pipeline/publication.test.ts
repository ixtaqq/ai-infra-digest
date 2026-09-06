import { describe, expect, it } from "vitest";
import type { GeneratedDigest } from "./types";
import {
  deserializeDigestPublication,
  serializeDigestPublication,
} from "./publication";

function generatedDigest(): GeneratedDigest {
  return {
    runDate: "2026-08-19",
    startTime: 123,
    formattedMessage: "daily digest",
    digest: {
      articles: [],
      topStocks: [],
      marketOutlook: "Neutral",
      summary: "Summary",
      categories: {},
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      batchesRun: 1,
    },
    articlesCollected: 4,
    feedStatuses: [],
    secExtracts: [],
    earningsAnalyses: [],
    stockPrices: new Map([
      [
        "NVDA",
        {
          ticker: "NVDA",
          price: 180,
          change: 2,
          changePercent: 1.12,
          previousClose: 178,
        },
      ],
    ]),
    activeWatches: [{ id: 1, chat_id: 99, ticker: "NVDA", threshold: 170, direction: "above" }],
    capabilities: Object.fromEntries(["primaryAi", "fallbackAi", "embeddings", "earnings", "supabase", "slack", "email"].map(key => [key, { state: "enabled", detail: "fixture" }])),
  } as unknown as GeneratedDigest;
}

describe("digest publication serialization", () => {
  it("round-trips immutable digest data and refreshes dynamic watches", () => {
    const generated = generatedDigest();
    const payload = serializeDigestPublication(generated);
    const currentWatches = [
      { id: 2, chat_id: 101, ticker: "NVDA", threshold: 190, direction: "below" as const },
    ];

    expect(payload).not.toHaveProperty("activeWatches");
    expect(payload).not.toHaveProperty("startTime");

    const hydrated = deserializeDigestPublication(payload, currentWatches, 456, 12);

    expect(hydrated.publicationId).toBe(12);
    expect(hydrated.startTime).toBe(456);
    expect(hydrated.stockPrices.get("NVDA")?.price).toBe(180);
    expect(hydrated.activeWatches).toEqual(currentWatches);
    expect(hydrated.formattedMessage).toBe("daily digest");
  });

  it("rejects malformed stored payloads", () => {
    expect(() => deserializeDigestPublication({ runDate: "2026-08-19" }, [], 1, 1)).toThrow(
      "Invalid digest publication payload"
    );
  });
  it.each([
    { digest: {} },
    { stockPrices: [["NVDA", {}]] },
    { secExtracts: [{}] },
    { earningsAnalyses: [{}] },
    { feedStatuses: [{}] },
  ])("rejects invalid nested data: %j", (invalid) => {
    const payload = { ...serializeDigestPublication(generatedDigest()), ...invalid };
    expect(() => deserializeDigestPublication(payload, [])).toThrow("Invalid digest publication payload");
  });
});
