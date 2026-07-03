import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config", () => ({
  config: {
    ai: {
      provider: "groq",
      apiKey: "test-key",
      model: "strong-model",
      fastModel: "fast-model",
      baseUrl: "https://api.test/v1",
      embeddingApiKey: "",
      embeddingModel: "text-embedding-3-small",
    },
  },
}));

vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { normalizeArticles, processArticles } from "./ai";
import type { Article } from "../collector/rss";

function makeArticle(overrides: Partial<Article> = {}): Article {
  return {
    title: "NVIDIA ships record GPUs",
    url: "https://example.com/a1",
    summary: "Record shipments.",
    source: "Test Feed",
    date: new Date("2026-07-01"),
    contentSnippet: "NVIDIA reported record GPU shipments this quarter.",
    ...overrides,
  };
}

/** A real Response instance — the openai SDK reads .status/.ok/.headers/.json() directly. */
function chatCompletionResponse(content: string, usage = { total_tokens: 100, prompt_tokens: 60, completion_tokens: 40 }) {
  return new Response(
    JSON.stringify({
      id: "test",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage,
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("normalizeArticles", () => {
  it("keeps valid rows and coerces a string impactScore to a number", () => {
    const result = normalizeArticles([
      {
        title: "Valid article",
        url: "https://example.com/1",
        source: "Test",
        summary: "s",
        impact: "Bullish",
        impactScore: "8", // model returned a string instead of a number
        affectedStocks: ["NVDA"],
        reason: "r",
        category: "Chips & GPUs",
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].impactScore).toBe(8);
    expect(typeof result[0].impactScore).toBe("number");
  });

  it("drops rows missing a title", () => {
    const result = normalizeArticles([
      { url: "https://example.com/1", impact: "Bullish", impactScore: 5, category: "Chips & GPUs" },
      { title: "Has a title", url: "https://example.com/2", impact: "Bullish", impactScore: 5, category: "Chips & GPUs" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Has a title");
  });

  it("falls back to safe defaults for invalid impact/category/affectedStocks", () => {
    const result = normalizeArticles([
      {
        title: "Weird row",
        impact: "SuperBullish", // not a valid enum value
        impactScore: "not-a-number",
        category: "Not A Real Category",
        affectedStocks: "NVDA", // should be an array, not a string
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].impact).toBe("Neutral");
    expect(result[0].impactScore).toBe(5);
    expect(result[0].affectedStocks).toEqual([]);
  });

  it("returns an empty array for a completely empty input", () => {
    expect(normalizeArticles([])).toEqual([]);
  });
});

describe("processArticles", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("processes a single batch and runs the synthesis pass", async () => {
    const fetchMock = vi.fn()
      // batch classification call
      .mockResolvedValueOnce(
        chatCompletionResponse(
          JSON.stringify({
            articles: [
              {
                title: "NVIDIA ships record GPUs",
                url: "https://example.com/a1",
                source: "Test Feed",
                summary: "• Record shipments",
                impact: "Bullish",
                impactScore: 8,
                relevanceScore: 9,
                affectedStocks: ["NVDA"],
                reason: "Strong demand",
                category: "Chips & GPUs",
              },
            ],
          })
        )
      )
      // synthesis call
      .mockResolvedValueOnce(
        chatCompletionResponse(
          JSON.stringify({
            topStocks: [{ ticker: "NVDA", reason: "Demand", sentiment: "positive" }],
            marketOutlook: "Bullish on GPU demand.",
            summary: "NVIDIA had a strong quarter.",
          })
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await processArticles([makeArticle()]);

    expect(result.articles).toHaveLength(1);
    expect(result.articles[0].impactScore).toBe(8);
    expect(result.topStocks).toEqual([{ ticker: "NVDA", reason: "Demand", sentiment: "positive" }]);
    expect(result.marketOutlook).toBe("Bullish on GPU demand.");
    expect(result.categories["Chips & GPUs"]).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers via retry when the first batch response is unparseable", async () => {
    const fetchMock = vi.fn()
      // first attempt: garbage, not JSON
      .mockResolvedValueOnce(chatCompletionResponse("I cannot help with that request."))
      // retry attempt (forced JSON mode): valid
      .mockResolvedValueOnce(
        chatCompletionResponse(
          JSON.stringify({
            articles: [
              {
                title: "Recovered article",
                url: "https://example.com/a2",
                source: "Test Feed",
                summary: "s",
                impact: "Neutral",
                impactScore: 4,
                affectedStocks: [],
                reason: "r",
                category: "Datacenters",
              },
            ],
          })
        )
      )
      // synthesis call
      .mockResolvedValueOnce(chatCompletionResponse(JSON.stringify({ topStocks: [] })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await processArticles([makeArticle()]);

    expect(result.articles).toHaveLength(1);
    expect(result.articles[0].title).toBe("Recovered article");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws when every batch fails to parse even after retry", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(chatCompletionResponse("not json"))
      .mockResolvedValueOnce(chatCompletionResponse("still not json"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(processArticles([makeArticle()])).rejects.toThrow(
      "All AI batches failed — no articles could be analyzed"
    );
  });

  it("falls back to default market outlook when synthesis returns malformed data", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        chatCompletionResponse(
          JSON.stringify({
            articles: [
              {
                title: "A",
                url: "https://example.com/a1",
                source: "Test",
                summary: "s",
                impact: "Bullish",
                impactScore: 7,
                affectedStocks: [],
                reason: "r",
                category: "Chips & GPUs",
              },
            ],
          })
        )
      )
      // synthesis: topStocks is a string instead of an array — whole synthesis object fails validation
      .mockResolvedValueOnce(chatCompletionResponse(JSON.stringify({ topStocks: "NVDA" })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await processArticles([makeArticle()]);
    expect(result.articles).toHaveLength(1);
    expect(result.marketOutlook).toBe("AI infrastructure spending remains a key focus across all sectors.");
    expect(result.topStocks).toEqual([]);
  });
});
