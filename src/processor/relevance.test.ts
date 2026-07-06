import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config", () => ({
  config: {
    ai: { embeddingApiKey: "test-key", embeddingModel: "text-embedding-3-small" },
  },
}));

vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("passesSemanticGate", () => {
  it("passes article with high cosine similarity to any seed", async () => {
    const { passesSemanticGate } = await import("./relevance");
    // seed-like vector and article vector pointing the same direction
    const seed = [1, 0, 0];
    const article = [0.99, 0.1, 0.0];
    expect(passesSemanticGate(article, [seed])).toBe(true);
  });

  it("blocks article with low cosine similarity to all seeds", async () => {
    const { passesSemanticGate } = await import("./relevance");
    const seed = [1, 0, 0];
    const article = [0, 1, 0]; // orthogonal
    expect(passesSemanticGate(article, [seed])).toBe(false);
  });
});

describe("embedSeeds", () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it("returns seed embeddings on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
      }),
    }));
    const { embedSeeds } = await import("./relevance");
    const result = await embedSeeds();
    expect(result[0]).toEqual([0.1, 0.2, 0.3]);
  });

  // withRetry does ~5s of real backoff sleeps before giving up on persistent 429,
  // which sits exactly at vitest's 5s default timeout — flaky under full-suite
  // parallel load. The retry-then-give-up behavior is what's under test, so keep
  // the real sleeps and give the test headroom instead.
  it("returns empty array on HTTP error", { timeout: 15_000 }, async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    const { embedSeeds } = await import("./relevance");
    const result = await embedSeeds();
    expect(result).toEqual([]);
  });
});
