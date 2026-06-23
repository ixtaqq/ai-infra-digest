import Parser from "rss-parser";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../utils/logger";
import { config } from "../config";
import { sleep } from "../utils/helpers";

// ─── Conditional GET Cache ─────────────────────────────
interface FeedCacheEntry {
  etag?: string;
  lastModified?: string;
  /** Number of consecutive failures (cleared on success) */
  consecutiveFailures: number;
}

const CACHE_FILE = path.join(config.app.cacheDir, "rss-headers.json");

function ensureCacheDir(): void {
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readFeedCache(): Map<string, FeedCacheEntry> {
  try {
    ensureCacheDir();
    if (!fs.existsSync(CACHE_FILE)) return new Map();
    const raw = fs.readFileSync(CACHE_FILE, "utf-8");
    return new Map(Object.entries(JSON.parse(raw)));
  } catch {
    return new Map();
  }
}

function writeFeedCache(cache: Map<string, FeedCacheEntry>): void {
  try {
    ensureCacheDir();
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify(Object.fromEntries(cache), null, 2),
      "utf-8"
    );
  } catch {
    // Non-critical — cache miss just means full re-fetch
  }
}

/**
 * Create a custom fetch wrapper that sends cached ETag/Last-Modified headers
 * and reads 304 responses to return empty results early.
 */
async function conditionalFetch(
  url: string,
  timeoutMs = 15000
): Promise<{
  body: string | null;
  status: number;
  etag?: string;
  lastModified?: string;
}> {
  const cache = readFeedCache();
  const entry = cache.get(url);

  const headers: Record<string, string> = {
    "User-Agent": "AI-Infra-Digest/1.0",
  };
  if (entry?.etag) headers["If-None-Match"] = entry.etag;
  if (entry?.lastModified) headers["If-Modified-Since"] = entry.lastModified;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);

    const etag = response.headers.get("ETag") || undefined;
    const lastModified = response.headers.get("Last-Modified") || undefined;

    if (response.status === 304) {
      logger.debug(`Conditional GET: 304 Not Modified for ${url}`);
      return { body: null, status: 304, etag, lastModified };
    }

    if (!response.ok) {
      return { body: null, status: response.status, etag, lastModified };
    }

    const body = await response.text();
    return { body, status: response.status, etag, lastModified };
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent": "AI-Infra-Digest/1.0",
  },
});

/**
 * Exponential backoff with full jitter for RSS fetch retries.
 * Waits in [0, baseDelay * 2^attempt) ms, then reports the sleep duration.
 */
async function rssBackoff(attempt: number, baseDelayMs = 2000): Promise<void> {
  const maxDelay = baseDelayMs * Math.pow(2, attempt);
  const waitMs = Math.random() * maxDelay;
  await sleep(waitMs);
}

// ─── Tier 1: Major company news + Financial news ───────
const TIER_1_FEEDS = [
  { url: "https://nvidianews.nvidia.com/news-rss", name: "NVIDIA" },
  { url: "https://news.microsoft.com/feed/", name: "Microsoft" },
  { url: "https://www.amd.com/en/newsroom/press-releases/rss.html", name: "AMD" },
  { url: "https://news.google.com/rss/search?q=Broadcom+AI&hl=en-US&gl=US&ceid=US:en", name: "Broadcom" },
  { url: "https://news.google.com/rss/search?q=Amazon+AWS+AI+infrastructure&hl=en-US&gl=US&ceid=US:en", name: "Amazon" },
  { url: "https://news.google.com/rss/search?q=Google+AI+infrastructure+datacenter&hl=en-US&gl=US&ceid=US:en", name: "Google" },
  { url: "https://news.google.com/rss/search?q=Meta+AI+infrastructure&hl=en-US&gl=US&ceid=US:en", name: "Meta" },
  { url: "https://news.google.com/rss/search?q=TSMC+AI+chips+semiconductor&hl=en-US&gl=US&ceid=US:en", name: "TSMC" },
  { url: "https://news.google.com/rss/search?q=Intel+AI+chips+foundry&hl=en-US&gl=US&ceid=US:en", name: "Intel" },
  { url: "https://news.google.com/rss/search?q=Qualcomm+AI+chips&hl=en-US&gl=US&ceid=US:en", name: "Qualcomm" },
  { url: "https://news.google.com/rss/search?q=Oracle+cloud+AI&hl=en-US&gl=US&ceid=US:en", name: "Oracle" },
  { url: "https://news.google.com/rss/search?q=IBM+AI+enterprise&hl=en-US&gl=US&ceid=US:en", name: "IBM" },
  { url: "https://news.google.com/rss/search?q=Micron+HBM+memory+AI&hl=en-US&gl=US&ceid=US:en", name: "Micron" },
  { url: "https://news.google.com/rss/search?q=ASML+semiconductor+equipment&hl=en-US&gl=US&ceid=US:en", name: "ASML" },
  { url: "https://news.google.com/rss/search?q=Super+Micro+AI+servers&hl=en-US&gl=US&ceid=US:en", name: "Super Micro" },
  { url: "https://news.google.com/rss/search?q=Dell+AI+servers+infrastructure&hl=en-US&gl=US&ceid=US:en", name: "Dell" },
  { url: "https://news.google.com/rss/search?q=ARM+AI+chips+architecture&hl=en-US&gl=US&ceid=US:en", name: "ARM" },
  { url: "https://news.google.com/rss/search?q=Arista+Networks+AI+networking&hl=en-US&gl=US&ceid=US:en", name: "Arista" },
  { url: "https://news.google.com/rss/search?q=Cisco+AI+networking&hl=en-US&gl=US&ceid=US:en", name: "Cisco" },
  { url: "https://news.google.com/rss/search?q=Marvell+AI+networking&hl=en-US&gl=US&ceid=US:en", name: "Marvell" },
  { url: "https://news.google.com/rss/search?q=Applied+Materials+semiconductor&hl=en-US&gl=US&ceid=US:en", name: "Applied Materials" },
  { url: "https://news.google.com/rss/search?q=Lam+Research+semiconductor&hl=en-US&gl=US&ceid=US:en", name: "Lam Research" },
  { url: "https://news.google.com/rss/search?q=KLA+semiconductor+inspection&hl=en-US&gl=US&ceid=US:en", name: "KLA" },
  { url: "https://news.google.com/rss/search?q=Tokyo+Electron+semiconductor&hl=en-US&gl=US&ceid=US:en", name: "Tokyo Electron" },
  { url: "https://news.google.com/rss/search?q=Digital+Realty+datacenter+AI&hl=en-US&gl=US&ceid=US:en", name: "Digital Realty" },
  { url: "https://news.google.com/rss/search?q=Equinix+datacenter+AI&hl=en-US&gl=US&ceid=US:en", name: "Equinix" },
  { url: "https://news.google.com/rss/search?q=Constellation+Energy+nuclear+AI+power&hl=en-US&gl=US&ceid=US:en", name: "Constellation Energy" },
  { url: "https://news.google.com/rss/search?q=Vistra+AI+power+demand&hl=en-US&gl=US&ceid=US:en", name: "Vistra" },
  { url: "https://news.google.com/rss/search?q=GE+Vernova+AI+power+grid&hl=en-US&gl=US&ceid=US:en", name: "GE Vernova" },
  { url: "https://news.google.com/rss/search?q=Siemens+Energy+AI+power&hl=en-US&gl=US&ceid=US:en", name: "Siemens Energy" },
  { url: "https://news.google.com/rss/search?q=Vertiv+AI+cooling+datacenter&hl=en-US&gl=US&ceid=US:en", name: "Vertiv" },
  { url: "https://news.google.com/rss/search?q=Schneider+Electric+AI+datacenter&hl=en-US&gl=US&ceid=US:en", name: "Schneider Electric" },
  { url: "https://news.google.com/rss/search?q=Eaton+AI+power+management&hl=en-US&gl=US&ceid=US:en", name: "Eaton" },
  { url: "https://news.google.com/rss/search?q=Anthropic+AI+Claude&hl=en-US&gl=US&ceid=US:en", name: "Anthropic" },
  { url: "https://news.google.com/rss/search?q=xAI+Grok+AI&hl=en-US&gl=US&ceid=US:en", name: "xAI" },
  { url: "https://news.google.com/rss/search?q=Mistral+AI&hl=en-US&gl=US&ceid=US:en", name: "Mistral AI" },
  { url: "https://news.google.com/rss/search?q=Cohere+AI+enterprise&hl=en-US&gl=US&ceid=US:en", name: "Cohere" },
  { url: "https://news.google.com/rss/search?q=SK+hynix+HBM+memory+AI&hl=en-US&gl=US&ceid=US:en", name: "SK hynix" },
  { url: "https://news.google.com/rss/search?q=Samsung+HBM+AI+memory&hl=en-US&gl=US&ceid=US:en", name: "Samsung" },
  { url: "https://news.google.com/rss/search?q=GlobalFoundries+AI+chips&hl=en-US&gl=US&ceid=US:en", name: "GlobalFoundries" },
  { url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", name: "MarketWatch" },
  { url: "https://finance.yahoo.com/news/rssindex", name: "Yahoo Finance" },
  { url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", name: "CNBC" },
  { url: "https://www.reutersagency.com/feed/?taxonomy=best-sectors&post_type=bundles&best-sectors=tech", name: "Reuters Tech" },
  { url: "https://www.bloomberg.com/technology/feeds", name: "Bloomberg Tech" },
  { url: "https://www.ft.com/technology?format=rss", name: "Financial Times Tech" },
  { url: "https://www.barrons.com/feed/top-stories", name: "Barron's" },
  { url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml", name: "WSJ Markets" },
  { url: "https://www.investors.com/category/news/feed/", name: "Investor's Business Daily" },
  { url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&CIK=&type=8-K&company=&dateb=&owner=include&start=0&count=20&output=atom", name: "SEC Filings" },
];

// ─── Tier 2: AI Infrastructure + Semiconductor news ────
const TIER_2_FEEDS = [
  { url: "https://www.tomshardware.com/feeds/all", name: "Tom's Hardware" },
  { url: "https://www.anandtech.com/rss", name: "AnandTech" },
  { url: "https://arstechnica.com/feed/", name: "Ars Technica" },
  { url: "https://techcrunch.com/feed/", name: "TechCrunch" },
  { url: "https://www.theverge.com/rss/index.xml", name: "The Verge" },
  { url: "https://seekingalpha.com/market_currents.xml", name: "Seeking Alpha" },
  { url: "https://www.semianalysis.com/feed", name: "SemiAnalysis" },
  { url: "https://www.theregister.com/headlines.rss", name: "The Register" },
  { url: "https://www.datacenterdynamics.com/en/feed/", name: "Datacenter Dynamics" },
  { url: "https://semiengineering.com/feed/", name: "Semiconductor Engineering" },
  { url: "https://blog.google/technology/ai/rss/", name: "Google AI Blog" },
  { url: "https://openai.com/blog/rss/", name: "OpenAI" },
  { url: "https://aws.amazon.com/blogs/ai/feed/", name: "AWS AI" },
  { url: "https://venturebeat.com/category/ai/feed/", name: "VentureBeat AI" },
  { url: "https://artificialintelligence-news.com/feed/", name: "AI News" },
  { url: "https://medium.com/feed/tag/artificial-intelligence", name: "Medium AI" },
  { url: "https://aibusiness.com/feed.rss", name: "AI Business" },
  { url: "https://www.zdnet.com/topic/artificial-intelligence/rss.xml", name: "ZDNet AI" },
];

// ─── Keywords ──────────────────────────────────────────
const AI_KEYWORDS = [
  "AI infrastructure", "GPU", "Blackwell", "datacenter", "data center",
  "inference", "training", "LLM", "AI spending", "cloud AI",
  "power demand", "semiconductor", "chip", "accelerator",
  "artificial intelligence", "machine learning",
  "HPC", "high performance computing",
  "cloud capex", "AI revenue", "earnings",
  "analyst upgrade", "analyst downgrade", "price target",
  "memory", "HBM", "CoWoS", "TSMC",
  "fabrication", "fab", "node", "process technology",
  "foundry", "wafer", "yield", "packaging", "advanced packaging",
  "NVIDIA", "NVDA", "AMD", "Broadcom", "AVGO",
  "Microsoft", "MSFT", "Amazon", "AMZN", "AWS",
  "Google", "GOOGL", "GOOG", "Alphabet",
  "Meta", "META", "Facebook",
  "OpenAI", "TSMC", "TSM",
  "Intel", "INTC", "Qualcomm", "QCOM",
  "Oracle", "ORCL", "OCI",
  "IBM", "Micron", "MU", "ASML",
  "Super Micro", "SMCI", "Dell", "DELL",
  "ARM", "ARM Holdings",
  "Cerebras", "SambaNova", "Graphcore",
  "HPE", "Hewlett Packard", "Cisco", "CSCO",
  "Marvell", "MRVL", "Arista", "ANET",
  "CrowdStrike", "Palantir", "PLTR", "Snowflake", "SNOW",
  "ServiceNow", "NOW", "Salesforce", "CRM",
  "H100", "H200", "B100", "B200", "B300",
  "MI300", "MI350", "MI400",
  "Gaudi", "Habana", "Trainium", "Inferentia",
  "TPU", "Trillium", "Dojo", "D1X",
  "Radeon", "Instinct", "CDNA", "ROCm",
  "CUDA", "Tensor Core", "TensorRT",
  "ASML", "Applied Materials", "AMAT", "Lam Research", "LRCX",
  "KLA", "KLAC", "Tokyo Electron",
  "EUV", "DUV", "lithography", "wafer fab", "deposition", "etch",
  "Arista", "ANET", "Cisco", "CSCO", "Juniper", "JNPR",
  "InfiniBand", "Ethernet AI", "AI networking", "optical interconnect",
  "network switch", "data center networking", "smart NIC", "DPU",
  "HBM", "HBM3E", "HBM4", "DDR5", "GDDR7",
  "memory shortage", "SK hynix", "Samsung memory",
  "Digital Realty", "DLR", "Equinix", "EQIX",
  "colocation", "AI capacity", "datacenter expansion",
  "Constellation Energy", "CEG", "Vistra", "VST",
  "GE Vernova", "GEV", "Siemens Energy",
  "power demand", "grid upgrades", "nuclear power", "AI electricity",
  "renewable energy", "SMR", "small modular reactor",
  "Vertiv", "VRT", "Schneider Electric", "Eaton", "ETN",
  "liquid cooling", "immersion cooling", "thermal management",
  "datacenter cooling", "Trane", "TT",
  "Anthropic", "Claude", "xAI", "Grok",
  "Mistral AI", "Cohere", "AI model", "frontier model",
  "foundation model", "open source model",
  "semiconductor manufacturing", "chip design",
  "M&A", "partnership", "joint venture",
  "guidance", "earnings report", "revenue guidance",
  "capex", "capital expenditure", "buyback", "dividend",
  "GlobalFoundries", "GFS", "Samsung",
];

export function matchesKeywords(title: string, content: string): boolean {
  const text = `${title} ${content}`.toLowerCase();
  return AI_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()));
}

// ─── Types ────────────────────────────────────────────
export interface Article {
  title: string;
  url: string;
  summary: string;
  source: string;
  date: Date;
  contentSnippet: string;
}

export interface FeedResult {
  name: string;
  url: string;
  status: "success" | "failed";
  articlesFetched: number;
  articles: Article[];
  error?: string;
  response_time_ms?: number;
}

// ─── Fetch with status tracking ────────────────────────
async function fetchFeedWithStatus(
  feed: { url: string; name: string },
  maxArticles: number
): Promise<FeedResult> {
  const startTime = Date.now();

  // Try conditional GET first — may return 304 (cached)
  const httpResult = await conditionalFetch(feed.url);
  if (httpResult.status === 304) {
    logger.info(`Cached content unchanged for ${feed.name} (304)`);
    return {
      name: feed.name,
      url: feed.url,
      status: "success",
      articlesFetched: 0,
      articles: [],
      response_time_ms: Date.now() - startTime,
    };
  }

  // Retry loop with exponential backoff
  const maxRetries = 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await parser.parseURL(feed.url);
    const articles: Article[] = [];

    for (const item of result.items) {
      if (articles.length >= maxArticles) break;
      const title = item.title?.trim();
      if (!title) continue;
      const contentSnippet =
        item.contentSnippet?.trim() ||
        item.content?.replace(/<[^>]*>/g, "").trim() ||
        "";
      articles.push({
        title,
        url: item.link || "",
        summary: contentSnippet.slice(0, 500),
        source: feed.name,
        date: item.pubDate ? new Date(item.pubDate) : new Date(),
        contentSnippet,
      });
    }

    // Update cache with response headers
    const cache = readFeedCache();
    const entry = cache.get(feed.url) || { consecutiveFailures: 0 };
    entry.etag = httpResult.etag || entry.etag;
    entry.lastModified = httpResult.lastModified || entry.lastModified;
    entry.consecutiveFailures = 0; // Reset on success
    cache.set(feed.url, entry);
    writeFeedCache(cache);

    logger.info(`Fetched ${articles.length} articles from ${feed.name} (${Date.now() - startTime}ms)`);
    return {
      name: feed.name,
      url: feed.url,
      status: "success",
      articlesFetched: articles.length,
      articles,
      response_time_ms: Date.now() - startTime,
    };
  } catch (error) {      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries) {
        logger.warn(`RSS retry ${attempt + 1}/${maxRetries} for ${feed.name}: ${lastError.message}`);
        await rssBackoff(attempt);
      }
    }
  }

  // All retries exhausted — increment failure counter
  const cache = readFeedCache();
  const entry = cache.get(feed.url) || { consecutiveFailures: 0 };
  entry.consecutiveFailures = (entry.consecutiveFailures || 0) + 1;
  cache.set(feed.url, entry);
  writeFeedCache(cache);

  logger.warn(`Failed to fetch ${feed.name} after ${maxRetries + 1} attempts: ${lastError?.message}`);
  return {
    name: feed.name,
    url: feed.url,
    status: "failed",
    articlesFetched: 0,
    articles: [],
    error: lastError?.message || "Unknown error",
    response_time_ms: Date.now() - startTime,
  };
}

// ─── Main collection ──────────────────────────────────

/** Feed names to skip (consistently failing). */
export const SKIPPED_FEEDS = new Set<string>();

/** Mark a feed to be skipped on future runs (e.g., after repeated failures). */
export function skipFeed(name: string): void {
  SKIPPED_FEEDS.add(name);
  logger.info(`Conditional RSS: skipping "${name}" on future runs`);
}

/** Reset skipped feeds list. */
export function resetSkippedFeeds(): void {
  SKIPPED_FEEDS.clear();
}

export async function collectArticles(
  skipFeeds?: Set<string>
): Promise<{
  articles: Article[];
  feedStatuses: FeedResult[];
}> {
  logger.info("Starting news collection...");

  let allFeeds = [...TIER_1_FEEDS, ...TIER_2_FEEDS];

  // Apply conditional skipping
  const combinedSkip = new Set([...SKIPPED_FEEDS, ...(skipFeeds || [])]);
  if (combinedSkip.size > 0) {
    allFeeds = allFeeds.filter((f) => !combinedSkip.has(f.name));
    logger.info(`Skipping ${combinedSkip.size} feeds: ${[...combinedSkip].slice(0, 10).join(", ")}${combinedSkip.size > 10 ? ` +${combinedSkip.size - 10} more` : ""}`);
  }
  const feedResults = await Promise.all(
    allFeeds.map((feed) => fetchFeedWithStatus(feed, config.app.maxArticlesPerSource))
  );

  let articles = feedResults.flatMap((r) => r.articles);

  // Filter by AI/semiconductor keywords
  const filtered = articles.filter((a) =>
    matchesKeywords(a.title, a.contentSnippet)
  );

  const finalArticles = filtered.length > 0
    ? filtered
    : articles.slice(0, 30);

  logger.info(
    `Collection complete: ${articles.length} total, ${finalArticles.length} AI-relevant (${feedResults.filter(r => r.status === 'success').length}/${feedResults.length} feeds healthy)`
  );

  return { articles: finalArticles, feedStatuses: feedResults };
}
