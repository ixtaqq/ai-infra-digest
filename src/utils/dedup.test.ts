import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// Mock config to use a temp cache directory for test isolation
const testCacheDir = path.join(os.tmpdir(), "ai-infra-digest-test-cache");

vi.mock("../config", () => ({
  config: {
    app: {
      cacheDir: testCacheDir,
      timezone: "Asia/Kuala_Lumpur",
      maxArticlesPerSource: 5,
    },
    telegram: { botToken: "test", chatId: "test" },
    ai: { provider: "groq", apiKey: "test", model: "test", baseUrl: "https://test.com" },
  },
}));

describe("deduplicateArticles", () => {
  const testCachePath = path.join(testCacheDir, "articles-cache.json");

  beforeEach(() => {
    // Clean up test cache before each test
    if (fs.existsSync(testCachePath)) {
      fs.unlinkSync(testCachePath);
    }
    if (fs.existsSync(testCacheDir)) {
      fs.rmdirSync(testCacheDir);
    }
  });

  afterEach(() => {
    // Clean up test cache after each test
    if (fs.existsSync(testCachePath)) {
      fs.unlinkSync(testCachePath);
    }
    if (fs.existsSync(testCacheDir)) {
      fs.rmdirSync(testCacheDir);
    }
  });

  it("should return all articles on first run (empty cache)", async () => {
    const { deduplicateArticles } = await import("./dedup");
    const articles = [
      { url: "https://example.com/1", title: "Article 1" },
      { url: "https://example.com/2", title: "Article 2" },
    ];
    const result = deduplicateArticles(articles, 48);
    expect(result).toHaveLength(2);
    expect(result[0].url).toBe("https://example.com/1");
  });

  it("should skip already-seen articles", async () => {
    const { deduplicateArticles } = await import("./dedup");
    const articles = [
      { url: "https://example.com/1", title: "Article 1" },
    ];
    // First call: all articles are new
    deduplicateArticles(articles, 48);
    // Second call with same articles: should be empty
    const result = deduplicateArticles(articles, 48);
    expect(result).toHaveLength(0);
  });

  it("should keep articles without URLs", async () => {
    const { deduplicateArticles } = await import("./dedup");
    const articles = [
      { url: "", title: "No URL" },
      { url: "https://example.com/1", title: "Has URL" },
    ];
    const firstRun = deduplicateArticles(articles, 48);
    expect(firstRun).toHaveLength(2);

    // Second run: no-URL article should pass through, has-URL should be skipped
    const secondRun = deduplicateArticles(articles, 48);
    expect(secondRun).toHaveLength(1);
    expect(secondRun[0].url).toBe("");
  });

  it("should deduplicate by URL, not by title", async () => {
    const { deduplicateArticles } = await import("./dedup");
    const article1 = { url: "https://example.com/1", title: "Same Title" };
    const article2 = { url: "https://example.com/2", title: "Same Title" };

    const firstRun = deduplicateArticles([article1, article2], 48);
    expect(firstRun).toHaveLength(2);

    // Same articles (dup URLs) should be skipped
    const secondRun = deduplicateArticles([article1, article2], 48);
    expect(secondRun).toHaveLength(0);
  });

  it("should respect retention hours", async () => {
    const { deduplicateArticles } = await import("./dedup");
    const articles = [
      { url: "https://example.com/1", title: "Article 1" },
    ];
    // First call adds to cache
    deduplicateArticles(articles, 0); // 0 hours retention = expire immediately
    // Second call: retention is 0, so previous entries are expired
    const result = deduplicateArticles(articles, 0);
    // With 0 retention, entries are expired and re-added
    expect(result).toHaveLength(1);
  });
});
