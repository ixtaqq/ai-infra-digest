/**
 * File-based AI response cache.
 *
 * Cache key: SHA-256 of sorted article URLs, truncated to 16 hex chars.
 * TTL: 23 hours — safe to re-use within the same calendar day but expires
 * before the next day's run so stale results never carry forward.
 *
 * Cache lives in `.ai-cache/` (gitignored). On a GitHub Actions runner the
 * directory is ephemeral anyway, so the cache only benefits local re-runs
 * (useful during development when the same feed snapshot is replayed).
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { logger } from "./logger";
import type { DigestResult } from "../processor/ai";

const CACHE_DIR = join(process.cwd(), ".ai-cache");
const TTL_MS = 23 * 60 * 60 * 1000;

interface CacheEntry {
  createdAt: number;
  result: DigestResult;
}

function cacheKey(articleUrls: string[]): string {
  const sorted = [...articleUrls].sort().join("|");
  return createHash("sha256").update(sorted).digest("hex").slice(0, 16);
}

function cachePath(key: string): string {
  return join(CACHE_DIR, `${key}.json`);
}

function ensureDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

export function getCached(articleUrls: string[]): DigestResult | null {
  try {
    const key = cacheKey(articleUrls);
    const file = cachePath(key);
    if (!existsSync(file)) return null;
    const entry = JSON.parse(readFileSync(file, "utf-8")) as CacheEntry;
    if (Date.now() - entry.createdAt > TTL_MS) {
      logger.info(`AI cache: entry ${key} expired`);
      return null;
    }
    logger.info(`AI cache: HIT ${key} (saved AI call)`);
    return entry.result;
  } catch {
    return null;
  }
}

export function setCached(articleUrls: string[], result: DigestResult): void {
  try {
    ensureDir();
    const key = cacheKey(articleUrls);
    const entry: CacheEntry = { createdAt: Date.now(), result };
    writeFileSync(cachePath(key), JSON.stringify(entry), "utf-8");
    logger.info(`AI cache: stored ${key}`);
  } catch (err) {
    logger.warn(`AI cache: write failed — ${(err as Error).message}`);
  }
}
