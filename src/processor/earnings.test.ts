import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config", () => ({
  config: { ai: { provider: "groq", apiKey: "test-key", model: "strong-model", fastModel: "fast-model", baseUrl: "https://api.test/v1" } },
}));

vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// callAI's retry backoff uses real sleep() between attempts — stub it so a
// rejected fetch doesn't add real multi-second delays to these tests.
vi.mock("../utils/helpers", () => ({ sleep: vi.fn(() => Promise.resolve()) }));

const h = vi.hoisted(() => ({
  getEarningsTranscriptMock: vi.fn(),
  upsertEarningsTranscriptMock: vi.fn(),
}));
vi.mock("../utils/supabase", () => ({
  supabase: {
    getEarningsTranscript: h.getEarningsTranscriptMock,
    upsertEarningsTranscript: h.upsertEarningsTranscriptMock,
  },
}));

import { analyzeEarningsTranscripts } from "./earnings";
import type { EarningsTranscript } from "../collector/earnings";

function makeTranscript(overrides: Partial<EarningsTranscript> = {}): EarningsTranscript {
  return {
    ticker: "NVDA",
    companyName: "NVIDIA Corporation",
    year: 2026,
    quarter: 2,
    date: "2026-06-15",
    content: "Thank you for joining our earnings call. We expect strong data center demand to continue.",
    ...overrides,
  };
}

function chatCompletionResponse(content: string) {
  return new Response(
    JSON.stringify({
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { total_tokens: 50, prompt_tokens: 30, completion_tokens: 20 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("analyzeEarningsTranscripts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.getEarningsTranscriptMock.mockResolvedValue(null);
    h.upsertEarningsTranscriptMock.mockResolvedValue(true);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns empty result immediately for an empty transcript list", async () => {
    const result = await analyzeEarningsTranscripts([]);
    expect(result.analyses).toEqual([]);
  });

  it("coerces numeric-looking strings in extracted metrics instead of crashing on .toFixed()", async () => {
    const fetchMock = vi
      .fn()
      // Pass 1: segmentation
      .mockResolvedValueOnce(
        chatCompletionResponse(JSON.stringify({ segments: [{ topic: "capex", relevance: 8, keyQuote: "q", summary: "s" }] }))
      )
      // Pass 2: extraction — revenueGuidance/capexGuidance returned as STRINGS
      .mockResolvedValueOnce(
        chatCompletionResponse(
          JSON.stringify({
            metrics: {
              revenueGuidance: "45000",
              epsGuidance: null,
              capexGuidance: "60000",
              aiRevenueMentioned: null,
              aiRevenueGrowthPct: null,
              capexSpend: null,
            },
            tone: { overall: "bullish", confidence: 8, keyPhrase: "strong demand", risksMentioned: [] },
            summary: "Strong quarter driven by AI infrastructure demand.",
            keyTakeaways: ["Capex raised"],
          })
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeEarningsTranscripts([makeTranscript()]);

    expect(result.analyses).toHaveLength(1);
    const analysis = result.analyses[0];
    expect(analysis.metrics.revenueGuidance).toBe(45000);
    expect(typeof analysis.metrics.revenueGuidance).toBe("number");
    expect(analysis.metrics.capexGuidance).toBe(60000);
    expect(analysis.tone.overall).toBe("bullish");
    expect(analysis.segments).toHaveLength(1);

    // The exact render path that used to crash on a string capex/revenue value.
    expect(() => `$${analysis.metrics.revenueGuidance!.toFixed(0)}M`).not.toThrow();
  });

  it("keeps safe defaults when Pass 2 extraction is unparseable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(chatCompletionResponse(JSON.stringify({ segments: [] })))
      .mockResolvedValueOnce(chatCompletionResponse("not valid json"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeEarningsTranscripts([makeTranscript()]);
    expect(result.analyses).toHaveLength(1);
    expect(result.analyses[0].metrics.revenueGuidance).toBeNull();
    expect(result.analyses[0].tone.overall).toBe("neutral");
  });

  it("computes a guidance delta against the previous quarter from Supabase", async () => {
    h.getEarningsTranscriptMock.mockResolvedValue({ revenue_guidance: 40000, capex_guidance: 50000 });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(chatCompletionResponse(JSON.stringify({ segments: [] })))
      .mockResolvedValueOnce(
        chatCompletionResponse(
          JSON.stringify({
            metrics: {
              revenueGuidance: 44000,
              epsGuidance: null,
              capexGuidance: 55000,
              aiRevenueMentioned: null,
              aiRevenueGrowthPct: null,
              capexSpend: null,
            },
            tone: { overall: "bullish", confidence: 7, keyPhrase: "p", risksMentioned: [] },
            summary: "s",
            keyTakeaways: [],
          })
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeEarningsTranscripts([makeTranscript()]);
    const delta = result.analyses[0].delta;
    expect(delta).not.toBeNull();
    expect(delta!.prevRevenueGuidance).toBe(40000);
    expect(delta!.revenueGuidanceChangePct).toBe(10); // (44000-40000)/40000 = +10%
    expect(delta!.toneDirection).toBe("improving");
  });

  it("degrades to defaults for one transcript but still analyzes the next", async () => {
    const fetchMock = vi
      .fn()
      // NVDA: both passes return unparseable content — degrades to safe defaults
      .mockResolvedValueOnce(chatCompletionResponse("not json"))
      .mockResolvedValueOnce(chatCompletionResponse("still not json"))
      // AMD: both passes succeed normally
      .mockResolvedValueOnce(chatCompletionResponse(JSON.stringify({ segments: [] })))
      .mockResolvedValueOnce(
        chatCompletionResponse(
          JSON.stringify({
            metrics: { revenueGuidance: 5000, epsGuidance: null, capexGuidance: null, aiRevenueMentioned: null, aiRevenueGrowthPct: null, capexSpend: null },
            tone: { overall: "cautious", confidence: 4, keyPhrase: "p", risksMentioned: [] },
            summary: "s",
            keyTakeaways: [],
          })
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeEarningsTranscripts([makeTranscript({ ticker: "NVDA" }), makeTranscript({ ticker: "AMD" })]);

    // analyzeTranscript never throws — it degrades to defaults per transcript,
    // so both still produce an analysis rather than one aborting the batch.
    expect(result.analyses).toHaveLength(2);
    expect(result.analyses[0].ticker).toBe("NVDA");
    expect(result.analyses[0].metrics.revenueGuidance).toBeNull();
    expect(result.analyses[1].ticker).toBe("AMD");
    expect(result.analyses[1].metrics.revenueGuidance).toBe(5000);
  });
});
