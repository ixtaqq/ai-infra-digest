import { describe, it, expect, vi } from "vitest";
import type { DigestResult, ProcessedArticle } from "../processor/ai";
import type { StockPrice } from "./stocks";

// derived-metrics.ts imports config (which loads env at module scope) + logger.
vi.mock("../config", () => ({
  config: { app: { supabaseUrl: undefined, supabaseServiceKey: undefined } },
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { buildRows } from "./derived-metrics";

function article(over: Partial<ProcessedArticle>): ProcessedArticle {
  return {
    title: "t",
    url: "https://x/" + Math.random(),
    source: "src",
    summary: "s",
    impact: "Neutral",
    impactScore: 5,
    affectedStocks: [],
    reason: "r",
    category: "Chips & GPUs",
    ...over,
  } as ProcessedArticle;
}

function digestOf(articles: ProcessedArticle[]): DigestResult {
  return { articles } as unknown as DigestResult;
}

const noPrices = new Map<string, StockPrice>();

describe("buildRows", () => {
  it("returns no rows for an empty digest", () => {
    expect(buildRows(digestOf([]), "2026-07-06", noPrices)).toEqual([]);
  });

  it("aggregates one sector row with impact mean and bull/bear counts", () => {
    const rows = buildRows(
      digestOf([
        article({ category: "Datacenters", impact: "Bullish", impactScore: 8 }),
        article({ category: "Datacenters", impact: "Bearish", impactScore: 4 }),
      ]),
      "2026-07-06",
      noPrices
    );
    const sector = rows.find((r) => r.entity_type === "sector" && r.entity === "Datacenters");
    expect(sector).toMatchObject({
      mention_count: 2,
      avg_impact_score: 6, // (8 + 4) / 2
      bullish_count: 1,
      bearish_count: 1,
    });
  });

  it("emits a ticker row per affected stock and counts a shared ticker across articles", () => {
    const rows = buildRows(
      digestOf([
        article({ affectedStocks: ["NVDA", "AMD"], impact: "Bullish", impactScore: 9 }),
        article({ affectedStocks: ["NVDA"], impact: "Bullish", impactScore: 7 }),
      ]),
      "2026-07-06",
      noPrices
    );
    const nvda = rows.find((r) => r.entity_type === "ticker" && r.entity === "NVDA");
    const amd = rows.find((r) => r.entity_type === "ticker" && r.entity === "AMD");
    expect(nvda).toMatchObject({ mention_count: 2, bullish_count: 2, avg_impact_score: 8 });
    expect(amd).toMatchObject({ mention_count: 1, bullish_count: 1 });
  });

  it("joins stock price data onto ticker rows when available, null otherwise", () => {
    const prices = new Map<string, StockPrice>([
      ["NVDA", { ticker: "NVDA", price: 123.45, changePercent: 2.1 } as StockPrice],
    ]);
    const rows = buildRows(
      digestOf([article({ affectedStocks: ["NVDA", "AMD"] })]),
      "2026-07-06",
      prices
    );
    const nvda = rows.find((r) => r.entity === "NVDA");
    const amd = rows.find((r) => r.entity === "AMD");
    expect(nvda).toMatchObject({ price_close: 123.45, price_change_pct: 2.1 });
    expect(amd).toMatchObject({ price_close: null, price_change_pct: null });
  });

  it("stamps every row with the given run date", () => {
    const rows = buildRows(digestOf([article({ affectedStocks: ["MSFT"] })]), "2026-07-06", noPrices);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.date === "2026-07-06")).toBe(true);
  });
});
