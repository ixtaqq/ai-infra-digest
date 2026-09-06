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

// ─── Cosine Similarity ────────────────────────────────

/**
 * Compute cosine similarity between two equal-length vectors.
 * Returns a value in [0, 1] where 1 = identical direction.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
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
  return path.join(config.app.cacheDir, "articles-cache.json");
}

async function loadCache(): Promise<CacheData> {
  try {
    const cachePath = getCachePath();
    const raw = await fs.promises.readFile(cachePath, "utf-8");
    return JSON.parse(raw) as CacheData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn("Failed to load article cache, starting fresh", {
        error: (error as Error).message,
      });
    }
  }
  return { entries: [] };
}

async function saveCache(cache: CacheData): Promise<void> {
  let tempPath = "";
  try {
    const cachePath = getCachePath();
    tempPath = `${cachePath}.${process.pid}.tmp`;
    await fs.promises.mkdir(config.app.cacheDir, { recursive: true });
    await fs.promises.writeFile(tempPath, JSON.stringify(cache, null, 2), "utf-8");
    await fs.promises.rename(tempPath, cachePath);
  } catch (error) {
    logger.warn("Failed to save article cache", {
      error: (error as Error).message,
    });
    if (tempPath) await fs.promises.unlink(tempPath).catch(() => undefined);
  }
}

/**
 * Cluster a batch of articles by URL + title similarity.
 * When an embeddingMap is provided, uses cosine similarity (threshold 0.85);
 * otherwise falls back to Jaccard (threshold 0.65).
 */
function clusterArticles(
  articles: Array<{ url: string; title: string }>,
  embeddingMap?: Map<string, number[]>
): Map<string, string[]> {
  const JACCARD_THRESHOLD = 0.65;
  const COSINE_THRESHOLD = 0.85;
  const clusters: Array<{ representativeUrl: string; title: string; urls: string[] }> = [];

  for (const article of articles) {
    if (!article.url) continue;

    const articleEmbed = embeddingMap?.get(article.url);

    const match = clusters.find((c) => {
      if (c.representativeUrl === article.url) return true;
      if (articleEmbed) {
        const clusterEmbed = embeddingMap?.get(c.representativeUrl);
        if (clusterEmbed) return cosineSimilarity(articleEmbed, clusterEmbed) >= COSINE_THRESHOLD;
      }
      return jaccardSimilarity(article.title, c.title) >= JACCARD_THRESHOLD;
    });

    if (match) {
      if (!match.urls.includes(article.url)) match.urls.push(article.url);
    } else {
      clusters.push({
        representativeUrl: article.url,
        title: article.title,
        urls: [article.url],
      });
    }
  }

  const result = new Map<string, string[]>();
  for (const cluster of clusters) {
    result.set(cluster.representativeUrl, cluster.urls);
  }
  return result;
}

/**
 * Build a corroboration map for the current article batch.
 * Returns Map<representativeUrl, sourceCount> where sourceCount is the number
 * of distinct outlets that reported the same story (cluster size).
 * Singletons return count = 1. Used to boost effectiveScore for multi-source stories.
 *
 * Call this BEFORE deduplicateArticles with the same raw article list so the
 * representative URL matches what the AI pipeline receives.
 */
export function buildCorroborationMap(
  articles: Array<{ url: string; title: string }>,
  embeddingMap?: Map<string, number[]>
): Map<string, number> {
  const clusters = clusterArticles(articles, embeddingMap);
  const result = new Map<string, number>();
  for (const [repUrl, urls] of clusters) {
    const publishers = new Set(urls.map((url) => {
      try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); }
      catch { return url; }
    }));
    result.set(repUrl, publishers.size);
  }
  return result;
}

/**
 * Removes entries older than the specified hours and
 * filters out articles that were already processed.
 */
export async function deduplicateArticles<T extends { url: string; title: string }>(
  articles: T[],
  retentionHours = 48
): Promise<T[]> {
  const cache = await loadCache();
  const now = new Date();
  const cutoff = new Date(now.getTime() - retentionHours * 60 * 60 * 1000);

  // Clean old entries
  cache.entries = cache.entries.filter(
    (e) => new Date(e.firstSeen) > cutoff
  );

  // Build set of seen URLs
  const seenUrls = new Set(cache.entries.map((e) => e.url));
  const seenTitles = cache.entries.map((e) => e.title);
  const batchUrls = new Set<string>();
  const batchTitles = new Set<string>();

  // Filter new articles (current-batch exact URL/title + cached Jaccard check)
  const SIMILARITY_THRESHOLD = 0.65;
  const newArticles = articles.filter((a) => {
    // Exact URL match
    if (a.url && (seenUrls.has(a.url) || batchUrls.has(a.url))) return false;

    // Exact title match within this batch
    if (a.title && batchTitles.has(a.title)) return false;

    if (!a.url) {
      if (a.title) batchTitles.add(a.title);
      return true; // Keep articles without URLs
    }

    // Jaccard similarity check — are we covering the same story from a different source?
    const titleSim = seenTitles.some((stored) => jaccardSimilarity(a.title, stored) >= SIMILARITY_THRESHOLD);
    if (titleSim) return false;

    batchUrls.add(a.url);
    if (a.title) batchTitles.add(a.title);
    return true;
  });

  // Add new articles to cache
  const newEntries: CacheEntry[] = newArticles.map((a) => ({
    url: a.url,
    title: a.title,
    firstSeen: now.toISOString(),
  }));

  cache.entries.push(...newEntries);
  await saveCache(cache);

  const skipped = articles.length - newArticles.length;
  if (skipped > 0) {
    logger.info(`Dedup: skipped ${skipped} articles (current-batch URL/title match + Jaccard similarity)`);
  }

  return newArticles;
}
