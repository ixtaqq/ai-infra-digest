import type { ProcessedArticle } from "../processor/ai";
import type { SECFinancialExtract } from "../processor/sec";
import type { StockPrice } from "./stocks";

const MIN_MOVE_PERCENT = 3;
const MIN_FILING_IMPACT = 7;
const MAX_MOVES = 3;

export interface ExplainedMove {
  ticker: string;
  changePercent: number;
  coverage: { title: string; url?: string };
}

function coverageFor(
  ticker: string,
  articles: ProcessedArticle[],
  extracts: SECFinancialExtract[]
): ExplainedMove["coverage"] | undefined {
  const filing = extracts
    .filter((extract) => extract.ticker === ticker && extract.impactScore >= MIN_FILING_IMPACT && extract.keyTakeaways[0])
    .sort((a, b) => b.impactScore - a.impactScore)[0];
  if (filing) {
    return { title: `${filing.formType}: ${filing.keyTakeaways[0]}`, url: filing.primaryDocumentUrl };
  }
  const article = articles
    // The first ticker is the story's subject. Later ones are often passing mentions.
    .filter((candidate) => candidate.affectedStocks[0] === ticker)
    .sort((a, b) => (b.effectiveScore ?? b.impactScore) - (a.effectiveScore ?? a.impactScore))[0];
  return article && { title: article.title, url: article.url };
}

/** The day's largest price moves that this edition has coverage for. */
export function explainMoves(
  prices: Map<string, StockPrice>,
  articles: ProcessedArticle[],
  extracts: SECFinancialExtract[]
): ExplainedMove[] {
  return [...prices.values()]
    .filter((price) => Math.abs(price.changePercent) >= MIN_MOVE_PERCENT)
    .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
    .flatMap((price) => {
      const coverage = coverageFor(price.ticker, articles, extracts);
      return coverage ? [{ ticker: price.ticker, changePercent: price.changePercent, coverage }] : [];
    })
    .slice(0, MAX_MOVES);
}
