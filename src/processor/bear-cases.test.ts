import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config", () => ({
  config: {
    ai: { provider: "groq", apiKey: "test-key", model: "test-model", fastModel: "fast", baseUrl: "https://api.test/v1" },
  },
}));

vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { parseResponse, generateBearCases } from "./bear-cases";
import type { ProcessedArticle } from "./ai";
import { logger } from "../utils/logger";

function makeArticle(overrides: Partial<ProcessedArticle> = {}): ProcessedArticle {
  return {
    title: "NVIDIA ships record GPUs",
    url: "https://example.com/a1",
    source: "Test",
    summary: "Record shipments.",
    impact: "Bullish",
    impactScore: 8,
    affectedStocks: ["NVDA"],
    reason: "r",
    category: "Chips & GPUs",
    ...overrides,
  };
}

describe("parseResponse", () => {
  it("parses plain JSON with a results array", () => {
    const rows = parseResponse('{"results":[{"index":1,"bearCase":"Priced in."}]}');
    expect(rows).toHaveLength(1);
    expect(rows[0].index).toBe(1);
    expect(rows[0].bearCase).toBe("Priced in.");
  });

  it("strips markdown code fences before parsing", () => {
    const fenced = '```json\n{"results":[{"index":2,"bearCase":"Margins compress."}]}\n```';
    const rows = parseResponse(fenced);
    expect(rows).toHaveLength(1);
    expect(rows[0].index).toBe(2);
  });

  it("returns [] for unparseable garbage", () => {
    expect(parseResponse("I cannot help with that.")).toEqual([]);
  });

  it("returns [] when JSON parses but has no results array", () => {
    expect(parseResponse('{"answer":"yes"}')).toEqual([]);
  });

  it("logs a malformed AI article index instead of dropping it silently", () => {
    vi.clearAllMocks();

    expect(parseResponse('{"results":[{"index":"not-a-number","bearCase":"Nope"}]}')).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("invalid AI article index not-a-number"));
  });
});

describe("generateBearCases index matching", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubAIResponse(content: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }] }),
      }))
    );
  }

  it("maps rows to articles by 1-based index, not URL echo", async () => {
    const articles = [
      makeArticle({ url: "https://example.com/a1", impactScore: 8 }),
      makeArticle({ url: "https://example.com/a2", impactScore: 9, title: "Deep dive target" }),
    ];
    stubAIResponse(
      JSON.stringify({
        results: [
          { index: 1, bearCase: "Bear one." },
          { index: 2, bearCase: "Bear two.", bullCase: "Bull two. More.", contextNote: "Context." },
        ],
      })
    );

    const result = await generateBearCases(articles);
    expect(result.bearCases.get("https://example.com/a1")).toBe("Bear one.");
    expect(result.bearCases.get("https://example.com/a2")).toBe("Bear two.");
    // Deep-dive attaches to the highest-scoring article (index 2)
    expect(result.deepDive?.url).toBe("https://example.com/a2");
    expect(result.deepDive?.bullCase).toBe("Bull two. More.");
  });

  it("ignores out-of-range indexes and rows without a bearCase", async () => {
    const articles = [makeArticle({ impactScore: 8 })];
    stubAIResponse(
      JSON.stringify({
        results: [
          { index: 5, bearCase: "Points nowhere." },
          { index: 1 }, // missing bearCase
        ],
      })
    );

    const result = await generateBearCases(articles);
    expect(result.bearCases.size).toBe(0);
    expect(result.deepDive).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("invalid article index 5"));
  });

  it("returns empty result when no articles meet the impact threshold", async () => {
    const articles = [makeArticle({ impactScore: 3 })];
    // fetch must not even be called
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await generateBearCases(articles);
    expect(result.bearCases.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns empty result (never throws) when the AI response is garbage", async () => {
    const articles = [makeArticle({ impactScore: 8 })];
    stubAIResponse("not json at all");

    const result = await generateBearCases(articles);
    expect(result.bearCases.size).toBe(0);
  });
});
