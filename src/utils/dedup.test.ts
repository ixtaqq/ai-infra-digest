import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cosineSimilarity } from "./dedup";
import fs from "fs";
import path from "path";
import os from "os";

// Mock config to use a temp cache directory for test isolation
const testCacheDir = path.join(os.tmpdir(), "ai-infra-digest-test-cache");

vi.mock("../config", () => {
  // vi.mock factory is hoisted — cannot reference testCacheDir declared below.
  // Use os.tmpdir() inline instead.
  const os = require("os") as typeof import("os");
  const path = require("path") as typeof import("path");
  return {
    config: {
      app: {
        cacheDir: path.join(os.tmpdir(), "ai-infra-digest-test-cache"),
        timezone: "Asia/Kuala_Lumpur",
        maxArticlesPerSource: 5,
      },
      telegram: { botToken: "test", chatId: "test" },
      ai: { provider: "groq", apiKey: "test", model: "test", baseUrl: "https://test.com" },
    },
  };
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
  });

  it("returns 0 for mismatched-length vectors (guard)", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
  });

  it("returns 0 for zero vectors", () => {
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });
});

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
    const result = await deduplicateArticles(articles, 48);
    expect(result).toHaveLength(2);
    expect(result[0].url).toBe("https://example.com/1");
  });

  it("should skip already-seen articles", async () => {
    const { deduplicateArticles } = await import("./dedup");
    const articles = [
      { url: "https://example.com/1", title: "Article 1" },
    ];
    // First call: all articles are new
    await deduplicateArticles(articles, 48);
    // Second call with same articles: should be empty
    const result = await deduplicateArticles(articles, 48);
    expect(result).toHaveLength(0);
  });

  it("should keep articles without URLs", async () => {
    const { deduplicateArticles } = await import("./dedup");
    const articles = [
      { url: "", title: "No URL" },
      { url: "https://example.com/1", title: "Has URL" },
    ];
    const firstRun = await deduplicateArticles(articles, 48);
    expect(firstRun).toHaveLength(2);

    // Second run: no-URL article should pass through, has-URL should be skipped
    const secondRun = await deduplicateArticles(articles, 48);
    expect(secondRun).toHaveLength(1);
    expect(secondRun[0].url).toBe("");
  });

  it("should remove exact URL and title duplicates within the current batch", async () => {
    const { deduplicateArticles } = await import("./dedup");
    const articles = [
      { url: "https://example.com/1", title: "Same story" },
      { url: "https://example.com/1", title: "Same story from another feed" },
      { url: "https://example.com/2", title: "Same story" },
      { url: "https://example.com/3", title: "Unrelated report" },
    ];

    const result = await deduplicateArticles(articles, 48);

    expect(result.map((article) => article.url)).toEqual([
      "https://example.com/1",
      "https://example.com/3",
    ]);
  });

  it("should respect retention hours", async () => {
    const { deduplicateArticles } = await import("./dedup");
    const articles = [
      { url: "https://example.com/1", title: "Article 1" },
    ];
    // First call adds to cache
    await deduplicateArticles(articles, 0); // 0 hours retention = expire immediately
    // Second call: retention is 0, so previous entries are expired
    const result = await deduplicateArticles(articles, 0);
    // With 0 retention, entries are expired and re-added
    expect(result).toHaveLength(1);
  });
});
