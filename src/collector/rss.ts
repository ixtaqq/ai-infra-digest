import Parser from "rss-parser";
import { logger } from "../utils/logger";
import { config } from "../config";

const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent": "AI-Infra-Digest/1.0",
  },
});

// ─── Tier 1: Major company news + Financial news ───────
const TIER_1_FEEDS = [
  // Major tech companies (via Google Alerts RSS / company blogs)
  { url: "https://nvidianews.nvidia.com/news-rss", name: "NVIDIA" },
  { url: "https://news.microsoft.com/feed/", name: "Microsoft" },
  { url: "https://www.amd.com/en/newsroom/press-releases/rss.html", name: "AMD" },

  // Financial news
  { url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", name: "MarketWatch" },
  { url: "https://finance.yahoo.com/news/rssindex", name: "Yahoo Finance" },
  { url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", name: "CNBC" },
  { url: "https://www.reutersagency.com/feed/?taxonomy=best-sectors&post_type=bundles&best-sectors=tech", name: "Reuters Tech" },

  // SEC filings (EDGAR RSS)
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

  // AI-specific
  { url: "https://blog.google/technology/ai/rss/", name: "Google AI Blog" },
  { url: "https://openai.com/blog/rss/", name: "OpenAI" },
  { url: "https://aws.amazon.com/blogs/ai/feed/", name: "AWS AI" },
  { url: "https://venturebeat.com/category/ai/feed/", name: "VentureBeat AI" },
];

// ─── AI/Semiconductor keywords for filtering ────────────
const AI_KEYWORDS = [
  "AI infrastructure", "GPU", "Blackwell", "datacenter", "data center",
  "inference", "training", "LLM", "AI spending", "cloud AI",
  "power demand", "semiconductor", "chip", "accelerator",
  "NVIDIA", "AMD", "Broadcom", "AVGO", "NVDA", "AMD",
  "Microsoft", "Amazon", "Google", "Meta", "OpenAI",
  "H100", "H200", "B100", "B200", "MI300", "MI350",
  "cloud capex", "AI revenue", "earnings",
  "analyst upgrade", "analyst downgrade", "price target",
  "artificial intelligence", "machine learning",
  "HPC", "high performance computing",
  "memory", "HBM", "CoWoS", "TSMC",
  "fabrication", "fab", "node", "process technology",
];

function matchesKeywords(title: string, content: string): boolean {
  const text = `${title} ${content}`.toLowerCase();
  return AI_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()));
}

export interface Article {
  title: string;
  url: string;
  summary: string;
  source: string;
  date: Date;
  contentSnippet: string;
}

async function fetchFeed(
  feed: { url: string; name: string },
  maxArticles: number
): Promise<Article[]> {
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

    logger.info(`Fetched ${articles.length} articles from ${feed.name}`);
    return articles;
  } catch (error) {
    logger.warn(`Failed to fetch ${feed.name}: ${(error as Error).message}`);
    return [];
  }
}

export async function collectArticles(): Promise<Article[]> {
  logger.info("Starting news collection...");

  const allFeeds = [...TIER_1_FEEDS, ...TIER_2_FEEDS];
  const results = await Promise.all(
    allFeeds.map((feed) => fetchFeed(feed, config.app.maxArticlesPerSource))
  );

  let articles = results.flat();

  // Filter by AI/semiconductor keywords
  const filtered = articles.filter((a) =>
    matchesKeywords(a.title, a.contentSnippet)
  );

  logger.info(
    `Collection complete: ${articles.length} total, ${filtered.length} AI-relevant`
  );

  if (filtered.length === 0) {
    // If keyword filtering removes everything, return top articles anyway
    logger.warn("No AI-relevant articles found by keywords, using all articles");
    return articles.slice(0, 30);
  }

  return filtered;
}
