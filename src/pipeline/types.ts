import type { FeedResult } from "../collector/rss";
import type { EarningsAnalysis } from "../processor/earnings";
import type { DeepDiveResult } from "../processor/bear-cases";
import type { DigestResult } from "../processor/ai";
import type { SECFinancialExtract } from "../processor/sec";
import type { CapabilityReport } from "../utils/capabilities";
import type { PriceWatch } from "../utils/price-watch";
import type { StockPrice } from "../utils/stocks";

export interface GeneratedDigest {
  digestRunId?: number;
  /** Stable database identity when this digest came from a canonical publication. */
  publicationId?: number;
  runDate: string;
  startTime: number;
  formattedMessage: string;
  digest: DigestResult;
  articlesCollected: number;
  feedStatuses: FeedResult[];
  secExtracts: SECFinancialExtract[];
  earningsAnalyses: EarningsAnalysis[];
  stockPrices: Map<string, StockPrice>;
  whatChanged?: string;
  deepDive?: DeepDiveResult;
  activeWatches: PriceWatch[];
  capabilities: CapabilityReport;
}
