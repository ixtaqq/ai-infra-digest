import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config", () => ({
  config: { ai: { apiKey: "test-key", model: "strong-model", baseUrl: "https://api.test/v1" }, app: { timezone: "Asia/Kuala_Lumpur" } },
}));

vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const h = vi.hoisted(() => ({
  queryRowsMock: vi.fn(),
  upsertTickerThesesMock: vi.fn(),
  insertTickerThesisHistoryMock: vi.fn(),
}));
vi.mock("../utils/supabase", () => ({
  supabase: {
    queryRows: h.queryRowsMock,
    upsertTickerTheses: h.upsertTickerThesesMock,
    insertTickerThesisHistory: h.insertTickerThesisHistoryMock,
  },
}));

import { parseThesisResponse, generateTheses, collectRecentCoverage } from "./thesis";

describe("parseThesisResponse", () => {
  it("parses a valid results array and coerces string index/confidence", () => {
    const rows = parseThesisResponse(
      JSON.stringify({
        results: [{ index: "1", bullCase: "Strong demand.", bearCase: "Margin risk.", confidence: "7", keyDrivers: ["GPU demand"] }],
      })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].index).toBe(1);
    expect(typeof rows[0].index).toBe("number");
    expect(rows[0].confidence).toBe(7);
  });

  it("strips markdown code fences before parsing", () => {
    const fenced = '```json\n{"results":[{"index":1,"bullCase":"a","bearCase":"b","confidence":5}]}\n```';
    expect(parseThesisResponse(fenced)).toHaveLength(1);
  });

  it("returns [] for unparseable garbage", () => {
    expect(parseThesisResponse("I cannot help with that.")).toEqual([]);
  });

  it("returns [] when JSON parses but has no results array", () => {
    expect(parseThesisResponse('{"answer":"yes"}')).toEqual([]);
  });

  it("drops rows with a non-numeric index instead of crashing", () => {
    const rows = parseThesisResponse(
      JSON.stringify({ results: [{ index: "not-a-number", bullCase: "a", bearCase: "b", confidence: 5 }] })
    );
    expect(rows).toEqual([]);
  });

  it("falls back confidence to 5 when the field is missing or invalid", () => {
    const rows = parseThesisResponse(
      JSON.stringify({ results: [{ index: 1, bullCase: "a", bearCase: "b", confidence: "n/a" }] })
    );
    expect(rows[0].confidence).toBe(5);
  });
});

describe("generateTheses", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("returns [] without calling the AI when there's no derived-metrics history", async () => {
    h.queryRowsMock.mockResolvedValue([]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateTheses();
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("generates and upserts theses matched back by index", async () => {
    h.queryRowsMock
      .mockResolvedValueOnce([
        { date: "2026-06-01", entity: "NVDA", mention_count: 10, avg_impact_score: 8, bullish_count: 8, bearish_count: 2, price_close: 900 },
        { date: "2026-06-30", entity: "NVDA", mention_count: 12, avg_impact_score: 8.5, bullish_count: 9, bearish_count: 1, price_close: 950 },
      ])
      .mockResolvedValueOnce([]) // sec_filings lookup
      .mockResolvedValueOnce([]); // recent-coverage lookup (v14)

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    results: [{ index: 1, bullCase: "Strong AI demand.", bearCase: "Valuation risk.", confidence: 8, keyDrivers: ["GPU demand"] }],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
    h.upsertTickerThesesMock.mockResolvedValue(true);
    h.insertTickerThesisHistoryMock.mockResolvedValue(true);

    const result = await generateTheses();
    expect(result).toHaveLength(1);
    expect(result[0].ticker).toBe("NVDA");
    expect(result[0].bull_case).toBe("Strong AI demand.");
    expect(h.upsertTickerThesesMock).toHaveBeenCalledTimes(1);
    expect(h.insertTickerThesisHistoryMock).toHaveBeenCalledTimes(1);
    const [historyTheses, weekOf] = h.insertTickerThesisHistoryMock.mock.calls[0];
    expect(historyTheses[0].ticker).toBe("NVDA");
    expect(weekOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("still returns the generated theses when the history insert fails (independent, best-effort write)", async () => {
    h.queryRowsMock
      .mockResolvedValueOnce([
        { date: "2026-06-01", entity: "NVDA", mention_count: 10, avg_impact_score: 8, bullish_count: 8, bearish_count: 2, price_close: 900 },
      ])
      .mockResolvedValueOnce([]) // sec_filings lookup
      .mockResolvedValueOnce([]); // recent-coverage lookup (v14)

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ results: [{ index: 1, bullCase: "b", bearCase: "b", confidence: 6 }] }) } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
    h.upsertTickerThesesMock.mockResolvedValue(true);
    h.insertTickerThesisHistoryMock.mockResolvedValue(false); // history write fails

    const result = await generateTheses();

    // The latest-only upsert succeeded and the function still returns the theses —
    // a failed history insert never blocks or reverts the main write.
    expect(result).toHaveLength(1);
    expect(h.upsertTickerThesesMock).toHaveBeenCalledTimes(1);
    expect(h.insertTickerThesisHistoryMock).toHaveBeenCalledTimes(1);
  });

  it("grounds the AI prompt in recent per-article coverage when it's available (TODO-2)", async () => {
    h.queryRowsMock
      .mockResolvedValueOnce([
        { date: "2026-06-01", entity: "NVDA", mention_count: 10, avg_impact_score: 8, bullish_count: 8, bearish_count: 2, price_close: 900 },
      ])
      .mockResolvedValueOnce([]) // sec_filings lookup
      .mockResolvedValueOnce([
        { title: "Nvidia unveils new chip", impact: "Bullish", affected_stocks: ["NVDA"], created_at: "2026-06-30T00:00:00Z" },
        { title: "Regulatory probe into GPU exports", impact: "Bearish", affected_stocks: ["NVDA"], created_at: "2026-06-29T00:00:00Z" },
      ]); // recent-coverage lookup (v14)

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ results: [{ index: 1, bullCase: "b", bearCase: "b", confidence: 6 }] }) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    h.upsertTickerThesesMock.mockResolvedValue(true);
    h.insertTickerThesisHistoryMock.mockResolvedValue(true);

    await generateTheses();

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const prompt = sentBody.messages[1].content as string;
    expect(prompt).toContain("Nvidia unveils new chip");
    expect(prompt).toContain("Regulatory probe into GPU exports");
    expect(prompt).toContain("Recent coverage:");
  });
});

describe("collectRecentCoverage", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns an empty map without querying when given no tickers", async () => {
    const result = await collectRecentCoverage([]);
    expect(result).toEqual(new Map());
    expect(h.queryRowsMock).not.toHaveBeenCalled();
  });

  it("groups headlines by ticker, newest first, capped per ticker", async () => {
    h.queryRowsMock.mockResolvedValueOnce([
      { title: "Story A", impact: "Bullish", affected_stocks: ["NVDA", "AMD"], created_at: "2026-07-03T00:00:00Z" },
      { title: "Story B", impact: "Bearish", affected_stocks: ["NVDA"], created_at: "2026-07-02T00:00:00Z" },
      { title: "Story C", impact: "Neutral", affected_stocks: ["AMD"], created_at: "2026-07-01T00:00:00Z" },
    ]);

    const result = await collectRecentCoverage(["NVDA", "AMD"]);

    expect(result.get("NVDA")).toEqual(["🟢 Story A", "🔴 Story B"]);
    expect(result.get("AMD")).toEqual(["🟢 Story A", "⚪ Story C"]);
  });

  it("caps at HEADLINES_PER_TICKER (3) even with more matching articles", async () => {
    h.queryRowsMock.mockResolvedValueOnce(
      Array.from({ length: 5 }, (_, i) => ({
        title: `Story ${i}`,
        impact: "Neutral",
        affected_stocks: ["NVDA"],
        created_at: `2026-07-0${5 - i}T00:00:00Z`,
      }))
    );

    const result = await collectRecentCoverage(["NVDA"]);
    expect(result.get("NVDA")).toHaveLength(3);
  });

  it("ignores stocks in the row that weren't asked for", async () => {
    h.queryRowsMock.mockResolvedValueOnce([
      { title: "Story A", impact: "Bullish", affected_stocks: ["NVDA", "TSLA"], created_at: "2026-07-01T00:00:00Z" },
    ]);

    const result = await collectRecentCoverage(["NVDA"]);
    expect(result.has("TSLA")).toBe(false);
  });
});
