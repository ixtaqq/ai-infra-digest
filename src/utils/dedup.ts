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

// ─── Jaccard Similarity ────────────────────────────────

/** Tokenize a string into a set of lower-cased words (3+ chars). */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((t) => t.length >= 3)
  );
}

/**
 * Compute Jaccard similarity between two strings.
 * Returns a value in [0, 1] where 1 = identical sets.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
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
  const seenTitles = cache.entries.map((e) => e.title);

  // Filter new articles (URL dedup + Jaccard similarity check)
  const SIMILARITY_THRESHOLD = 0.65;
  const newArticles = articles.filter((a) => {
    if (!a.url) return true; // Keep articles without URLs

    // Exact URL match
    if (seenUrls.has(a.url)) return false;

    // Jaccard similarity check — are we covering the same story from a different source?
    const titleSim = seenTitles.some((stored) => jaccardSimilarity(a.title, stored) >= SIMILARITY_THRESHOLD);
    if (titleSim) return false;

    return true;
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
    logger.info(`Dedup: skipped ${skipped} articles (URL match + Jaccard similarity)`);
  }

  return newArticles;
}
