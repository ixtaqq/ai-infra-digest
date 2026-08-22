import type { DigestResult } from "../processor/ai";
import { normalizeTickerSymbols } from "../utils/tickers";

export interface SignalQualityMetrics {
  articleCount: number;
  sourceIdentityCoverage: number;
  invalidTickerCount: number;
  highImpactArticleCount: number;
  highImpactJustificationRate: number;
}

export interface SignalQualityAssessment {
  passed: boolean;
  issues: string[];
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0
    ? 0
    : Math.round((numerator / denominator) * 1000) / 1000;
}

export function evaluateSignalQuality(
  digest: DigestResult
): SignalQualityMetrics {
  const articles = digest.articles || [];
  const verifiedCount = articles.filter(
    (article) => article.sourceIdentityVerified === true
  ).length;
  const tickers = articles.flatMap((article) => article.affectedStocks || []);
  const invalidTickerCount =
    tickers.filter((ticker) => normalizeTickerSymbols([ticker]).length === 0).length +
    articles.reduce((total, article) => total + (article.invalidTickerCount || 0), 0);
  const highImpact = articles.filter((article) => article.impactScore >= 8);
  const justified = highImpact.filter(
    (article) => article.reason.trim().length >= 20
  ).length;

  return {
    articleCount: articles.length,
    sourceIdentityCoverage: ratio(verifiedCount, articles.length),
    invalidTickerCount,
    highImpactArticleCount: highImpact.length,
    highImpactJustificationRate: ratio(justified, highImpact.length),
  };
}

/** Deterministic release/operations baseline; it reports defects without hiding the edition. */
export function assessSignalQuality(
  metrics: SignalQualityMetrics
): SignalQualityAssessment {
  const issues: string[] = [];

  if (metrics.articleCount > 0 && metrics.sourceIdentityCoverage < 0.95) {
    issues.push("source identity coverage is below 95%");
  }
  if (metrics.invalidTickerCount > 0) {
    issues.push(`${metrics.invalidTickerCount} invalid ticker reference(s)`);
  }
  if (
    metrics.highImpactArticleCount > 0 &&
    metrics.highImpactJustificationRate < 1
  ) {
    issues.push("one or more high-impact articles lack a substantive justification");
  }

  return { passed: issues.length === 0, issues };
}
