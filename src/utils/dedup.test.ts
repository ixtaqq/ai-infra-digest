import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cosineSimilarity, buildCorroborationMap } from "./dedup";
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
    const { deduplicateArticles, markArticlesSeen } = await import("./dedup");
    const articles = [
      { url: "https://example.com/1", title: "Article 1" },
      { url: "https://example.com/2", title: "Article 2" },
    ];
    const result = await deduplicateArticles(articles, 48);
    expect(result).toHaveLength(2);
    expect(result[0].url).toBe("https://example.com/1");
  });

  it("should skip already-seen articles", async () => {
    const { deduplicateArticles, markArticlesSeen } = await import("./dedup");
    const articles = [
      { url: "https://example.com/1", title: "Article 1" },
    ];
    await deduplicateArticles(articles, 48);
    await markArticlesSeen(articles, 48);
    const result = await deduplicateArticles(articles, 48);
    expect(result).toHaveLength(0);
  });

  it("keeps an article eligible until it has been marked as analyzed", async () => {
    const { deduplicateArticles, markArticlesSeen } = await import("./dedup");
    const articles = [{ url: "https://example.com/unselected", title: "Unselected story" }];
    await deduplicateArticles(articles, 48);
    expect(await deduplicateArticles(articles, 48)).toHaveLength(1);
  });

  it("marks an article once however many times it is marked", async () => {
    const { markArticlesSeen } = await import("./dedup");
    const articles = [{ url: "https://example.com/1", title: "Article 1" }];
    await markArticlesSeen(articles, 48);
    await markArticlesSeen(articles, 48);
    expect(JSON.parse(fs.readFileSync(testCachePath, "utf8")).entries).toHaveLength(1);
  });

  it("should keep articles without URLs", async () => {
    const { deduplicateArticles, markArticlesSeen } = await import("./dedup");
    const articles = [
      { url: "", title: "No URL" },
      { url: "https://example.com/1", title: "Has URL" },
    ];
    const firstRun = await deduplicateArticles(articles, 48);
    expect(firstRun).toHaveLength(2);
    await markArticlesSeen(articles, 48);

    // Second run: no-URL article should pass through, has-URL should be skipped
    const secondRun = await deduplicateArticles(articles, 48);
    expect(secondRun).toHaveLength(1);
    expect(secondRun[0].url).toBe("");
  });

  it("should remove exact URL and title duplicates within the current batch", async () => {
    const { deduplicateArticles, markArticlesSeen } = await import("./dedup");
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

  it("skips a URL the feed republishes after the title window ends", async () => {
    const { deduplicateArticles, markArticlesSeen } = await import("./dedup");
    const url = "https://example.com/republished";
    await markArticlesSeen([{ url, title: "Republished story about GPUs" }]);
    const cachePath = path.join(testCacheDir, "articles-cache.json");
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    cache.entries[0].firstSeen = new Date(Date.now() - 5 * 24 * 3_600_000).toISOString();
    fs.writeFileSync(cachePath, JSON.stringify(cache));

    expect(await deduplicateArticles([{ url, title: "Republished story about GPUs" }])).toEqual([]);
  });

  it("allows a similar headline at a new URL after the title window ends", async () => {
    const { deduplicateArticles, markArticlesSeen } = await import("./dedup");
    await markArticlesSeen([{ url: "https://example.com/old", title: "NVIDIA announces new GPU roadmap" }]);
    const cachePath = path.join(testCacheDir, "articles-cache.json");
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    cache.entries[0].firstSeen = new Date(Date.now() - 5 * 24 * 3_600_000).toISOString();
    fs.writeFileSync(cachePath, JSON.stringify(cache));

    const fresh = [{ url: "https://example.com/new", title: "NVIDIA announces new GPU roadmap" }];
    expect(await deduplicateArticles(fresh)).toEqual(fresh);
  });

  it("should respect retention hours", async () => {
    const { deduplicateArticles, markArticlesSeen } = await import("./dedup");
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


describe("publisher corroboration", () => {
  it("counts repeated entries and same-publisher URLs once", () => {
    const title = "Nvidia builds new AI infrastructure datacenter";
    const articles = ["https://example.com/a", "https://example.com/a", "https://www.example.com/b", "https://another.com/a"].map(url => ({ url, title }));
    expect(buildCorroborationMap(articles).get(articles[0].url)).toBe(2);
  });
});
