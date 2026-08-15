import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (ctx: { chatId: number; text: string }) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  queryDerivedMetrics: vi.fn(),
}));

vi.mock("../sender/telegram", () => ({
  registerCommand: (name: string, handler: Handler) => h.handlers.set(name, handler),
}));
vi.mock("../utils/derived-metrics", () => ({ queryDerivedMetrics: h.queryDerivedMetrics }));
vi.mock("../utils/supabase", () => ({
  supabase: { isConfigured: () => true },
}));
vi.mock("../utils/trust-scores", () => ({
  getTrustScores: vi.fn(async () => ({ source: new Map(), sector: new Map() })),
}));

import { registerTrendCommands } from "./trends";

beforeEach(() => {
  h.handlers.clear();
  h.queryDerivedMetrics.mockReset();
  registerTrendCommands();
});

describe("/trends week-over-week output", () => {
  it("does not compare the latest value with the oldest short-history row", async () => {
    h.queryDerivedMetrics.mockResolvedValue(
      Array.from({ length: 7 }, (_, index) => ({
        date: `2026-07-0${index + 1}`,
        entity_type: "ticker",
        entity: "NVDA",
        mention_count: index === 6 ? 10 : 1,
        avg_impact_score: 7,
        price_close: null,
        price_change_pct: null,
      }))
    );

    const result = await h.handlers.get("trends")!({ chatId: 1, text: "/trends NVDA 30d" });
    expect((result as { text: string }).text).toContain("WoW delta unavailable");
    expect((result as { text: string }).text).not.toContain("+900% WoW");
  });

  it("uses the row seven days back once eight observations exist", async () => {
    h.queryDerivedMetrics.mockResolvedValue(
      Array.from({ length: 8 }, (_, index) => ({
        date: `2026-07-${String(index + 1).padStart(2, "0")}`,
        entity_type: "ticker",
        entity: "NVDA",
        mention_count: index === 7 ? 10 : 5,
        avg_impact_score: 7,
        price_close: null,
        price_change_pct: null,
      }))
    );

    const result = await h.handlers.get("trends")!({ chatId: 1, text: "/trends NVDA 30d" });
    expect((result as { text: string }).text).toContain("+100%</b> WoW (5 → 10)");
  });
});
