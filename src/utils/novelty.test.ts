import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProcessedArticle } from "../processor/ai";

vi.mock("../config", () => ({
  config: {
    app: {
      supabaseUrl: "https://test.supabase.co",
      supabaseServiceKey: "test-key",
    },
    telegram: { botToken: "test", chatId: "test" },
    ai: { provider: "groq", apiKey: "test", model: "test", baseUrl: "https://test.com" },
  },
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeArticle(title: string): ProcessedArticle {
  return {
    title,
    url: `https://example.com/${encodeURIComponent(title)}`,
    source: "TestSource",
    summary: "",
    impact: "Neutral" as const,
    impactScore: 5,
    affectedStocks: [],
    reason: "",
    category: "AI Models & Labs" as const,
  };
}

describe("flagRehashes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("flags articles with high title similarity to recent DB articles", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { title: "NVIDIA announces new GPU for data centers" },
        { title: "Google expands AI infrastructure investment" },
      ],
    }));

    const { flagRehashes } = await import("./novelty");
    const articles = [
      makeArticle("NVIDIA announces latest GPU for data centers"),
      makeArticle("Breaking news about quantum computing"),
    ];

    await flagRehashes(articles);

    expect(articles[0].isRehash).toBe(true);
    expect(articles[1].isRehash).toBeUndefined();
  });

  it("flags nothing when no recent articles in DB", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    }));

    const { flagRehashes } = await import("./novelty");
    const articles = [makeArticle("Some fresh breaking news")];

    await flagRehashes(articles);

    expect(articles[0].isRehash).toBeUndefined();
  });

  it("skips silently when fetch returns non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

    const { flagRehashes } = await import("./novelty");
    const articles = [makeArticle("Some article")];

    await expect(flagRehashes(articles)).resolves.toBeUndefined();
    expect(articles[0].isRehash).toBeUndefined();
  });

  it("throws on fetch network error (caught by tryStage in production)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const { flagRehashes } = await import("./novelty");
    const articles = [makeArticle("Some article")];

    await expect(flagRehashes(articles)).rejects.toThrow("Network error");
  });
});
