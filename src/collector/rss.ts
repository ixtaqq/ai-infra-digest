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
  // AI chip & semiconductor companies
  { url: "https://nvidianews.nvidia.com/news-rss", name: "NVIDIA" },
  { url: "https://news.microsoft.com/feed/", name: "Microsoft" },
  { url: "https://www.amd.com/en/newsroom/press-releases/rss.html", name: "AMD" },

  // More AI infrastructure companies (via Google News topic RSS)
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

  // Networking
  { url: "https://news.google.com/rss/search?q=Arista+Networks+AI+networking&hl=en-US&gl=US&ceid=US:en", name: "Arista" },
  { url: "https://news.google.com/rss/search?q=Cisco+AI+networking&hl=en-US&gl=US&ceid=US:en", name: "Cisco" },
  { url: "https://news.google.com/rss/search?q=Marvell+AI+networking&hl=en-US&gl=US&ceid=US:en", name: "Marvell" },

  // Semiconductor equipment
  { url: "https://news.google.com/rss/search?q=Applied+Materials+semiconductor&hl=en-US&gl=US&ceid=US:en", name: "Applied Materials" },
  { url: "https://news.google.com/rss/search?q=Lam+Research+semiconductor&hl=en-US&gl=US&ceid=US:en", name: "Lam Research" },
  { url: "https://news.google.com/rss/search?q=KLA+semiconductor+inspection&hl=en-US&gl=US&ceid=US:en", name: "KLA" },
  { url: "https://news.google.com/rss/search?q=Tokyo+Electron+semiconductor&hl=en-US&gl=US&ceid=US:en", name: "Tokyo Electron" },

  // Datacenter REITs
  { url: "https://news.google.com/rss/search?q=Digital+Realty+datacenter+AI&hl=en-US&gl=US&ceid=US:en", name: "Digital Realty" },
  { url: "https://news.google.com/rss/search?q=Equinix+datacenter+AI&hl=en-US&gl=US&ceid=US:en", name: "Equinix" },

  // Power & Energy
  { url: "https://news.google.com/rss/search?q=Constellation+Energy+nuclear+AI+power&hl=en-US&gl=US&ceid=US:en", name: "Constellation Energy" },
  { url: "https://news.google.com/rss/search?q=Vistra+AI+power+demand&hl=en-US&gl=US&ceid=US:en", name: "Vistra" },
  { url: "https://news.google.com/rss/search?q=GE+Vernova+AI+power+grid&hl=en-US&gl=US&ceid=US:en", name: "GE Vernova" },
  { url: "https://news.google.com/rss/search?q=Siemens+Energy+AI+power&hl=en-US&gl=US&ceid=US:en", name: "Siemens Energy" },

  // Cooling infrastructure
  { url: "https://news.google.com/rss/search?q=Vertiv+AI+cooling+datacenter&hl=en-US&gl=US&ceid=US:en", name: "Vertiv" },
  { url: "https://news.google.com/rss/search?q=Schneider+Electric+AI+datacenter&hl=en-US&gl=US&ceid=US:en", name: "Schneider Electric" },
  { url: "https://news.google.com/rss/search?q=Eaton+AI+power+management&hl=en-US&gl=US&ceid=US:en", name: "Eaton" },

  // AI model companies
  { url: "https://news.google.com/rss/search?q=Anthropic+AI+Claude&hl=en-US&gl=US&ceid=US:en", name: "Anthropic" },
  { url: "https://news.google.com/rss/search?q=xAI+Grok+AI&hl=en-US&gl=US&ceid=US:en", name: "xAI" },
  { url: "https://news.google.com/rss/search?q=Mistral+AI&hl=en-US&gl=US&ceid=US:en", name: "Mistral AI" },
  { url: "https://news.google.com/rss/search?q=Cohere+AI+enterprise&hl=en-US&gl=US&ceid=US:en", name: "Cohere" },

  // Memory & Storage
  { url: "https://news.google.com/rss/search?q=SK+hynix+HBM+memory+AI&hl=en-US&gl=US&ceid=US:en", name: "SK hynix" },
  { url: "https://news.google.com/rss/search?q=Samsung+HBM+AI+memory&hl=en-US&gl=US&ceid=US:en", name: "Samsung" },
  { url: "https://news.google.com/rss/search?q=GlobalFoundries+AI+chips&hl=en-US&gl=US&ceid=US:en", name: "GlobalFoundries" },

  // Financial news
  { url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", name: "MarketWatch" },
  { url: "https://finance.yahoo.com/news/rssindex", name: "Yahoo Finance" },
  { url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", name: "CNBC" },
  { url: "https://www.reutersagency.com/feed/?taxonomy=best-sectors&post_type=bundles&best-sectors=tech", name: "Reuters Tech" },
  { url: "https://www.bloomberg.com/technology/feeds", name: "Bloomberg Tech" },
  { url: "https://www.ft.com/technology?format=rss", name: "Financial Times Tech" },
  { url: "https://www.barrons.com/feed/top-stories", name: "Barron's" },
  { url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml", name: "WSJ Markets" },
  { url: "https://www.investors.com/category/news/feed/", name: "Investor's Business Daily" },

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
  { url: "https://www.semianalysis.com/feed", name: "SemiAnalysis" },
  { url: "https://www.theregister.com/headlines.rss", name: "The Register" },
  { url: "https://www.datacenterdynamics.com/en/feed/", name: "Datacenter Dynamics" },
  { url: "https://semiengineering.com/feed/", name: "Semiconductor Engineering" },

  // AI-specific
  { url: "https://blog.google/technology/ai/rss/", name: "Google AI Blog" },
  { url: "https://openai.com/blog/rss/", name: "OpenAI" },
  { url: "https://aws.amazon.com/blogs/ai/feed/", name: "AWS AI" },
  { url: "https://venturebeat.com/category/ai/feed/", name: "VentureBeat AI" },
  { url: "https://artificialintelligence-news.com/feed/", name: "AI News" },
  { url: "https://medium.com/feed/tag/artificial-intelligence", name: "Medium AI" },
  { url: "https://aibusiness.com/feed.rss", name: "AI Business" },
  { url: "https://www.zdnet.com/topic/artificial-intelligence/rss.xml", name: "ZDNet AI" },
];

// ─── AI/Semiconductor keywords for filtering ────────────
const AI_KEYWORDS = [
  // Core AI infrastructure
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

  // Company names & tickers
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

  // GPU & AI hardware
  "H100", "H200", "B100", "B200", "B300",
  "MI300", "MI350", "MI400",
  "Gaudi", "Habana", "Trainium", "Inferentia",
  "TPU", "Trillium", "Dojo", "D1X",
  "Radeon", "Instinct", "CDNA", "ROCm",
  "CUDA", "Tensor Core", "TensorRT",

  // Semiconductor equipment
  "ASML", "Applied Materials", "AMAT", "Lam Research", "LRCX",
  "KLA", "KLAC", "Tokyo Electron",
  "EUV", "DUV", "lithography", "wafer fab", "deposition", "etch",

  // Networking
  "Arista", "ANET", "Cisco", "CSCO", "Juniper", "JNPR",
  "InfiniBand", "Ethernet AI", "AI networking", "optical interconnect",
  "network switch", "data center networking", "smart NIC", "DPU",

  // Memory & Storage
  "HBM", "HBM3E", "HBM4", "DDR5", "GDDR7",
  "memory shortage", "SK hynix", "Samsung memory",

  // Datacenter REITs
  "Digital Realty", "DLR", "Equinix", "EQIX",
  "colocation", "AI capacity", "datacenter expansion", "data center leasing",

  // Power & Energy
  "Constellation Energy", "CEG", "Vistra", "VST",
  "GE Vernova", "GEV", "Siemens Energy",
  "power demand", "grid upgrades", "nuclear power", "AI electricity",
  "renewable energy", "SMR", "small modular reactor",

  // Cooling
  "Vertiv", "VRT", "Schneider Electric", "Eaton", "ETN",
  "liquid cooling", "immersion cooling", "thermal management",
  "datacenter cooling", "Trane", "TT",

  // AI model companies
  "Anthropic", "Claude", "xAI", "Grok",
  "Mistral AI", "Cohere", "AI model", "frontier model",
  "foundation model", "open source model",

  // Sector categories
  "semiconductor manufacturing", "chip design",
  "M&A", "partnership", "joint venture",
  "guidance", "earnings report", "revenue guidance",
  "capex", "capital expenditure", "buyback", "dividend",

  // Additional tickers
  "GlobalFoundries", "GFS", "Samsung",
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
