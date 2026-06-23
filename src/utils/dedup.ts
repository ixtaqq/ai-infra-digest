import fs from "fs";
import path from "path";
import { config } from "../config";
import { logger } from "./logger";

interface CacheEntry {
  url: string;
  title: string;
  firstSeen: string; // ISO date
}

interface CacheData {
  entries: CacheEntry[];
}

function getCachePath(): string {
  const dir = config.app.cacheDir;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, "articles-cache.json");
}

function loadCache(): CacheData {
  try {
    const cachePath = getCachePath();
    if (fs.existsSync(cachePath)) {
      const raw = fs.readFileSync(cachePath, "utf-8");
      return JSON.parse(raw) as CacheData;
    }
  } catch (error) {
    logger.warn("Failed to load article cache, starting fresh", {
      error: (error as Error).message,
    });
  }
  return { entries: [] };
}

function saveCache(cache: CacheData): void {
  try {
    const cachePath = getCachePath();
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8");
  } catch (error) {
    logger.warn("Failed to save article cache", {
      error: (error as Error).message,
    });
  }
}

/**
 * Removes entries older than the specified hours and
 * filters out articles that were already processed.
 */
export function deduplicateArticles<T extends { url: string; title: string }>(
  articles: T[],
  retentionHours = 48
): T[] {
  const cache = loadCache();
  const now = new Date();
  const cutoff = new Date(now.getTime() - retentionHours * 60 * 60 * 1000);

  // Clean old entries
  cache.entries = cache.entries.filter(
    (e) => new Date(e.firstSeen) > cutoff
  );

  // Build set of seen URLs
  const seenUrls = new Set(cache.entries.map((e) => e.url));

  // Filter new articles
  const newArticles = articles.filter((a) => {
    if (!a.url) return true; // Keep articles without URLs
    return !seenUrls.has(a.url);
  });

  // Add new articles to cache
  const newEntries: CacheEntry[] = newArticles.map((a) => ({
    url: a.url,
    title: a.title,
    firstSeen: now.toISOString(),
  }));

  cache.entries.push(...newEntries);
  saveCache(cache);

  const skipped = articles.length - newArticles.length;
  if (skipped > 0) {
    logger.info(`Dedup: skipped ${skipped} already-processed articles`);
  }

  return newArticles;
}
