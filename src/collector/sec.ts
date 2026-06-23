/**
 * SEC EDGAR Filing Collector
 *
 * Fetches recent 8-K filings for tracked AI infrastructure companies via
 * the SEC's public data.sec.gov REST API.
 *
 * SEC API documentation: https://www.sec.gov/edgar/sec-api-documentation
 * Requirements:
 *  - Max 10 requests per second
 *  - Must send a descriptive User-Agent header with contact info
 */

import { logger } from "../utils/logger";
import { config } from "../config";
import { sleep } from "../utils/helpers";

// ─── Types ──────────────────────────────────────────────

export interface SECFiling {
  /** CIK number (without leading zeros) */
  cik: string;
  /** Company ticker */
  ticker: string;
  /** Company name */
  companyName: string;
  /** Filing type: 8-K, 10-K, 10-Q */
  formType: string;
  /** Filing date (YYYY-MM-DD) */
  filingDate: string;
  /** SEC accession number (used to construct document URLs) */
  accessionNumber: string;
  /** Primary document URL on SEC.gov */
  primaryDocumentUrl: string;
  /** Full filing description / items disclosed */
  items: string[];
  /** Raw filing text extracted from primary document (truncated for AI) */
  rawText: string;
  /** URL to the XBRL / financial data if available */
  xbrlUrl?: string;
  /** Brief one-line description of the filing */
  description: string;
}

export interface SECFilingResult {
  ticker: string;
  companyName: string;
  cik: string;
  status: "success" | "failed" | "no_new_filings";
  filings: SECFiling[];
  error?: string;
  responseTimeMs: number;
}

export interface SECCollectorResult {
  results: SECFilingResult[];
  totalFilings: number;
  newFilings: SECFiling[];
}

// ─── Company to CIK Mapping ──────────────────────────
// Tier 1: Key public AI-infrastructure companies tracked for SEC filings
// CIK numbers are stable identifiers used by the SEC EDGAR system.
// Source: https://www.sec.gov/files/company_tickers.json

interface CompanyEntry {
  ticker: string;
  name: string;
  cik: string; // CIK as string (with leading zeros when needed)
  tier: 1 | 2;
}

export const TRACKED_COMPANIES: CompanyEntry[] = [
  // Tier 1 — Core AI infrastructure (primary monitoring)
  { ticker: "NVDA",  name: "NVIDIA Corporation",            cik: "0001045810", tier: 1 },
  { ticker: "AMD",   name: "Advanced Micro Devices",        cik: "0000002488", tier: 1 },
  { ticker: "AVGO",  name: "Broadcom Inc.",                 cik: "0001730168", tier: 1 },
  { ticker: "MSFT",  name: "Microsoft Corporation",         cik: "0000789019", tier: 1 },
  { ticker: "AMZN",  name: "Amazon.com Inc.",               cik: "0001018724", tier: 1 },
  { ticker: "GOOGL", name: "Alphabet Inc.",                 cik: "0001652044", tier: 1 },
  { ticker: "META",  name: "Meta Platforms Inc.",           cik: "0001326801", tier: 1 },
  { ticker: "TSM",   name: "Taiwan Semiconductor (ADR)",    cik: "0001122304", tier: 1 },
  { ticker: "INTC",  name: "Intel Corporation",             cik: "0000050863", tier: 1 },
  { ticker: "QCOM",  name: "Qualcomm Inc.",                 cik: "0000804328", tier: 1 },
  { ticker: "ORCL",  name: "Oracle Corporation",            cik: "0001341439", tier: 1 },
  { ticker: "IBM",   name: "International Business Machines",cik: "0000051143", tier: 1 },
  { ticker: "MU",    name: "Micron Technology Inc.",        cik: "0000723125", tier: 1 },
  { ticker: "ASML",  name: "ASML Holding N.V.",             cik: "0000937966", tier: 1 },
  { ticker: "SMCI",  name: "Super Micro Computer Inc.",     cik: "0001375365", tier: 1 },
  { ticker: "DELL",  name: "Dell Technologies Inc.",        cik: "0001571996", tier: 1 },
  { ticker: "AMAT",  name: "Applied Materials Inc.",        cik: "0000006951", tier: 1 },
  { ticker: "LRCX",  name: "Lam Research Corporation",      cik: "0000707549", tier: 1 },
  { ticker: "KLAC",  name: "KLA Corporation",               cik: "0000319016", tier: 1 },
  { ticker: "CSCO",  name: "Cisco Systems Inc.",            cik: "0000858877", tier: 1 },
  // Alternate Tier 2 — secondary monitoring
  { ticker: "MRVL",  name: "Marvell Technology Inc.",       cik: "0001835632", tier: 2 },
  { ticker: "ANET",  name: "Arista Networks Inc.",          cik: "0001596538", tier: 2 },
  { ticker: "DLR",   name: "Digital Realty Trust Inc.",     cik: "0001426046", tier: 2 },
  { ticker: "EQIX",  name: "Equinix Inc.",                  cik: "0001102541", tier: 2 },
  { ticker: "CEG",   name: "Constellation Energy Corp.",    cik: "0001868275", tier: 2 },
  { ticker: "VST",   name: "Vistra Corp.",                  cik: "0001692819", tier: 2 },
  { ticker: "GEV",   name: "GE Vernova Inc.",               cik: "0001996862", tier: 2 },
  { ticker: "VRT",   name: "Vertiv Holdings Co.",           cik: "0001637864", tier: 2 },
  { ticker: "ETN",   name: "Eaton Corporation PLC",         cik: "0001551182", tier: 2 },
  { ticker: "ARM",   name: "Arm Holdings PLC (ADR)",        cik: "0001973239", tier: 2 },
  { ticker: "WDC",   name: "Western Digital Corp.",         cik: "0000100040", tier: 2 },
  { ticker: "ON",    name: "ON Semiconductor Corp.",        cik: "0001097864", tier: 2 },
  { ticker: "STX",   name: "Seagate Technology Holdings",   cik: "0001137789", tier: 2 },
  { ticker: "ANSS",  name: "Ansys Inc.",                    cik: "0001013462", tier: 2 },
  { ticker: "SNPS",  name: "Synopsys Inc.",                 cik: "0000883241", tier: 2 },
];

const USER_AGENT = "AI-Infra-Digest/2.0 (SEC filing analysis; contact: ai-infra@example.com)";

// ─── SEC API Helpers ────────────────────────────────────

/**
 * Fetch JSON from a SEC.gov API endpoint.
 * SEC requires a descriptive User-Agent and max 10 req/s.
 */
async function secFetch<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`SEC API HTTP ${response.status}: ${response.statusText} for ${url}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Rate-limit helper: ensure at most 10 requests per second.
 * We use a conservative 120ms gap between requests.
 */
let lastRequestTime = 0;
async function rateLimitedFetch<T>(url: string): Promise<T> {
  const now = Date.now();
  const gap = 150; // ms between requests (~6.7 req/s, well under 10/s limit)
  if (now - lastRequestTime < gap) {
    await sleep(gap - (now - lastRequestTime));
  }
  lastRequestTime = Date.now();
  return secFetch<T>(url);
}

// ─── Filing Types ───────────────────────────────────────

/** Filing types we're interested in, ordered by priority.
 * 8-K = material events (earnings, M&A, guidance changes)
 * 10-Q = quarterly financials
 * 10-K = annual financials
 */
export const INTERESTING_FORM_TYPES = new Set(["8-K", "10-K", "10-Q", "10-K/A", "10-Q/A", "8-K/A"]);

// ─── Fetch Filings for a Company ────────────────────────

interface SubmissionsResponse {
  cik: string;
  name: string;
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      form: string[];
      primaryDocument: string[];
      primaryDocDescription: string[];
      items: string[];
    };
  };
}

interface CompanyFactsResponse {
  cik: string;
  entityName: string;
  facts: {
    "us-gaap"?: Record<string, {
      label: string;
      description: string;
      units: Record<string, {
        end: string;
        val: number;
        fy?: number;
        fp?: string;
        form: string;
      }[]>;
    }>;
    "ifrs-full"?: Record<string, unknown>;
  };
}

/**
 * Fetch recent SEC filings for a given company.
 * Returns the raw text of the most recent 8-K (or 10-K/10-Q if no 8-K).
 */
export async function fetchCompanyFilings(company: CompanyEntry): Promise<SECFilingResult> {
  const startTime = Date.now();
  const cik10 = company.cik.padStart(10, "0");

  try {
    // Step 1: Fetch recent filings from submissions API
    const submissionsUrl = `https://data.sec.gov/submissions/CIK${cik10}.json`;
    const submissions = await rateLimitedFetch<SubmissionsResponse>(submissionsUrl);

    const recent = submissions.filings.recent;
    if (!recent?.accessionNumber?.length) {
      return {
        ticker: company.ticker,
        companyName: company.name,
        cik: company.cik,
        status: "no_new_filings",
        filings: [],
        responseTimeMs: Date.now() - startTime,
      };
    }

    // Step 2: Find recent filings of interest (8-K, 10-K, 10-Q)
    const interestingFilings: SECFiling[] = [];

    for (let i = 0; i < recent.accessionNumber.length; i++) {
      const formType = recent.form[i];
      if (!INTERESTING_FORM_TYPES.has(formType)) continue;
      if (interestingFilings.length >= 3) break; // Max 3 filings per company

      const accessionNo = recent.accessionNumber[i];
      const filingDate = recent.filingDate[i];
      const primaryDoc = recent.primaryDocument[i];
      const desc = recent.primaryDocDescription[i] || "";
      const items = (recent.items?.[i] || "")
        .split(/\s+/)
        .filter(Boolean);

      // Skip filings older than 60 days
      const filingAgeDays = (Date.now() - new Date(filingDate).getTime()) / 86400000;
      if (filingAgeDays > 60) continue;

      // Build the document URL
      const cikNoLeading = company.cik.replace(/^0+/, "");
      const accessionNoDir = accessionNo.replace(/-/g, ""); // e.g. "000104581025000012"
      const docUrl = `https://www.sec.gov/Archives/edgar/data/${cikNoLeading}/${accessionNoDir}/${primaryDoc}`;

      // Step 3: Download the primary document text
      let rawText = "";
      try {
        rawText = await downloadFilingText(docUrl);
      } catch (downloadError) {
        logger.warn(`SEC download failed for ${company.ticker} ${formType}: ${(downloadError as Error).message}`);
        // Continue with empty text — AI can still use metadata
      }

      interestingFilings.push({
        cik: company.cik,
        ticker: company.ticker,
        companyName: company.name,
        formType,
        filingDate,
        accessionNumber: accessionNo,
        primaryDocumentUrl: docUrl,
        items,
        rawText: rawText.slice(0, 15000), // Truncate for AI context window
        description: desc,
      });
    }

    return {
      ticker: company.ticker,
      companyName: company.name,
      cik: company.cik,
      status: interestingFilings.length > 0 ? "success" : "no_new_filings",
      filings: interestingFilings,
      responseTimeMs: Date.now() - startTime,
    };
  } catch (error) {
    const errMsg = (error as Error).message;
    logger.warn(`SEC fetch failed for ${company.ticker}: ${errMsg}`);
    return {
      ticker: company.ticker,
      companyName: company.name,
      cik: company.cik,
      status: "failed",
      filings: [],
      error: errMsg,
      responseTimeMs: Date.now() - startTime,
    };
  }
}

/**
 * Download the raw text of an SEC filing document.
 * SEC requires a descriptive User-Agent.
 */
async function downloadFilingText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,text/plain,application/xml,*/*",
    },
  });

  if (!response.ok) {
    throw new Error(`Download HTTP ${response.status}`);
  }

  const html = await response.text();

  // Strip HTML tags to get readable text
  const text = html
    .replace(/<[^>]*>/g, " ")    // Remove tags
    .replace(/&nbsp;/g, " ")     // Remove &nbsp;
    .replace(/&amp;/g, "&")      // Fix ampersands
    .replace(/&lt;/g, "<")       // Fix less-than
    .replace(/&gt;/g, ">")       // Fix greater-than
    .replace(/\s+/g, " ")        // Collapse whitespace
    .replace(/\n\s*\n/g, "\n\n") // Collapse blank lines
    .trim();

  return text;
}

// ─── Main Collection ────────────────────────────────────

/**
 * Collect recent SEC filings for all tracked companies.
 * Fetches Tier 1 companies first, then Tier 2 with a gap.
 */
export async function collectSECFilings(): Promise<SECCollectorResult> {
  logger.info("Starting SEC filing collection...");

  const tier1 = TRACKED_COMPANIES.filter((c) => c.tier === 1);
  const tier2 = TRACKED_COMPANIES.filter((c) => c.tier === 2);

  const allResults: SECFilingResult[] = [];

  // Fetch Tier 1 companies in parallel (batched to avoid rate limits)
  logger.info(`Fetching SEC filings for ${tier1.length} Tier 1 companies...`);
  const tier1Results = await Promise.all(
    tier1.map((company) => fetchCompanyFilings(company))
  );
  allResults.push(...tier1Results);

  // Small delay before Tier 2
  await sleep(1000);

  // Fetch Tier 2 companies
  logger.info(`Fetching SEC filings for ${tier2.length} Tier 2 companies...`);
  const tier2Results = await Promise.all(
    tier2.map((company) => fetchCompanyFilings(company))
  );
  allResults.push(...tier2Results);

  // Collect all new, interesting filings
  const newFilings: SECFiling[] = [];
  const companyStatuses: { ticker: string; status: string; count: number }[] = [];

  for (const result of allResults) {
    companyStatuses.push({
      ticker: result.ticker,
      status: result.status,
      count: result.filings.length,
    });
    for (const filing of result.filings) {
      newFilings.push(filing);
    }
  }

  // Sort by date (newest first) and form type (8-K first)
  newFilings.sort((a, b) => {
    const dateCmp = b.filingDate.localeCompare(a.filingDate);
    if (dateCmp !== 0) return dateCmp;
    // Prefer 8-K over 10-Q over 10-K
    const priority = (f: SECFiling) =>
      f.formType === "8-K" ? 0 : f.formType === "10-Q" ? 1 : f.formType === "10-K" ? 2 : 3;
    return priority(a) - priority(b);
  });

  const successful = companyStatuses.filter((s) => s.status === "success" || s.status === "no_new_filings").length;
  const failed = companyStatuses.filter((s) => s.status === "failed").length;

  logger.info(
    `SEC collection complete: ${newFilings.length} filings from ${allResults.length} companies ` +
    `(${successful} ok, ${failed} failed)`
  );

  return {
    results: allResults,
    totalFilings: newFilings.length,
    newFilings,
  };
}

/**
 * Get a list of only 8-K filings from a collection of filings.
 */
export function get8KFilings(filings: SECFiling[]): SECFiling[] {
  return filings.filter((f) => f.formType === "8-K");
}

/**
 * Get the most impactful filings (8-K with specific items, or any filing with financial data).
 * Returns top N filings by priority.
 */
export function getTopFilings(filings: SECFiling[], maxCount = 3): SECFiling[] {
  // Sort: 8-K items about earnings/guidance first
  const earningsItems = new Set([
    "2.02", // Results of Operations and Financial Condition
    "7.01", // Regulation FD Disclosure (often guidance)
    "8.01", // Other Events (often material developments)
  ]);

  const scored = filings.map((f) => {
    let score = 0;
    if (f.formType === "8-K") score += 3;
    if (f.formType === "10-K") score += 2;
    if (f.formType === "10-Q") score += 1;
    // Bonus for earnings-related items
    const hasEarningsItem = f.items.some((item) => earningsItems.has(item));
    if (hasEarningsItem) score += 2;
    // Bonus for more recent
    const daysAgo = (Date.now() - new Date(f.filingDate).getTime()) / 86400000;
    if (daysAgo < 7) score += 1;
    return { filing: f, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxCount).map((s) => s.filing);
}
