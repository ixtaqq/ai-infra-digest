import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config", () => ({
  config: { ai: { embeddingApiKey: "test-embed-key", embeddingModel: "text-embedding-3-small" } },
}));

vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// withRetry's own backoff/jitter isn't this file's concern — replace it with a
// single passthrough call so these tests run instantly and deterministically,
// while keeping the real HttpError/isRetryableStatus used by embeddings.ts.
vi.mock("../utils/retry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/retry")>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

import { generateEmbeddings } from "./embeddings";
import type { ProcessedArticle } from "./ai";

function makeArticle(overrides: Partial<ProcessedArticle> = {}): ProcessedArticle {
  return {
    title: "Article",
    url: "https://example.com/a",
    source: "Test",
    summary: "s",
    impact: "Neutral",
    impactScore: 5,
    affectedStocks: [],
    reason: "r",
    category: "Chips & GPUs",
    ...overrides,
  };
}

function makeArticles(n: number): ProcessedArticle[] {
  return Array.from({ length: n }, (_, i) => makeArticle({ url: `https://example.com/a${i}`, title: `Article ${i}` }));
}

function embeddingResponse(vectors: number[][]) {
  return new Response(
    JSON.stringify({ data: vectors.map((embedding, index) => ({ index, embedding })) }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("generateEmbeddings", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("returns an empty map without calling fetch when no embedding key is configured", async () => {
    vi.doMock("../config", () => ({ config: { ai: { embeddingApiKey: "", embeddingModel: "m" } } }));
    vi.resetModules();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { generateEmbeddings: generateEmbeddingsNoKey } = await import("./embeddings");
    const result = await generateEmbeddingsNoKey(makeArticles(1));

    expect(result.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an empty map without calling fetch for an empty article list", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateEmbeddings([])).resolves.toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps returned vectors back to article URLs by index", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(embeddingResponse([[0.1, 0.2], [0.3, 0.4]])));

    const articles = makeArticles(2);
    const result = await generateEmbeddings(articles);

    expect(result.size).toBe(2);
    expect(result.get(articles[0].url)).toEqual([0.1, 0.2]);
    expect(result.get(articles[1].url)).toEqual([0.3, 0.4]);
  });

  it("sends batches with the configured model and maps all successful batches", async () => {
    const articles = makeArticles(25);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(embeddingResponse(Array.from({ length: 20 }, (_, index) => [index])))
      .mockResolvedValueOnce(embeddingResponse(Array.from({ length: 5 }, (_, index) => [index + 20])));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateEmbeddings(articles);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstRequest = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    const secondRequest = JSON.parse(String(fetchMock.mock.calls[1][1].body));
    expect(firstRequest).toEqual({
      model: "text-embedding-3-small",
      input: articles.slice(0, 20).map((article) => `${article.title} ${article.summary}`),
    });
    expect(secondRequest.input).toHaveLength(5);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-embed-key",
      },
    });
    expect(result.size).toBe(25);
    expect(result.get(articles[24].url)).toEqual([24]);
  });

  it("ignores API vector indexes that do not map to the current batch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              { index: 0, embedding: [0.1] },
              { index: 99, embedding: [9.9] },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );

    const articles = makeArticles(1);
    const result = await generateEmbeddings(articles);

    expect(result.size).toBe(1);
    expect(result.get(articles[0].url)).toEqual([0.1]);
  });

  it("trips the circuit breaker on a persistent 429 and skips remaining batches", async () => {
    // 25 articles => 2 batches of 20 + 5 (EMBED_BATCH_SIZE = 20)
    const articles = makeArticles(25);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateEmbeddings(articles);

    expect(result.size).toBe(0);
    // Only the first batch should have been attempted before the breaker trips.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("continues to the next batch on a non-429 failure instead of aborting entirely", async () => {
    const articles = makeArticles(25);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 })) // batch 1 fails, not a quota issue
      .mockResolvedValueOnce(embeddingResponse(Array.from({ length: 5 }, () => [1, 2]))); // batch 2 succeeds
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateEmbeddings(articles);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.size).toBe(5); // only batch 2's articles got embeddings
  });
});
