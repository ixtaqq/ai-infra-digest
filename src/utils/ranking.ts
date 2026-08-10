export interface RankingInputs {
  impactScore: number;
  relevanceScore?: number;
  sourceTrust: number;
  sourceCredibility: number;
  sectorTrust: number;
  corroborationCount: number;
  isRehash: boolean;
  isPRWire: boolean;
}

export interface RankingExplanation {
  version: 1;
  baseImpactScore: number;
  relevanceScore: number | null;
  multipliers: {
    sourceTrust: number;
    sourceCredibility: number;
    sectorTrust: number;
    corroboration: number;
    novelty: number;
  };
  corroborationCount: number;
  uncappedScore: number;
  finalScore: number;
  cap: "pr_wire" | null;
  reasons: string[];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function calculateRanking(inputs: RankingInputs): RankingExplanation {
  const corroborationCount = Math.max(1, Math.floor(inputs.corroborationCount));
  const corroboration = 1 + (corroborationCount - 1) * 0.05;
  const novelty = inputs.isRehash ? 0.6 : 1;
  const uncappedScore =
    inputs.impactScore *
    inputs.sourceTrust *
    inputs.sourceCredibility *
    inputs.sectorTrust *
    corroboration *
    novelty;
  const cap = inputs.isPRWire && uncappedScore > 6 ? "pr_wire" : null;
  const finalScore = cap ? 6 : uncappedScore;
  const reasons: string[] = [];

  if (inputs.sourceTrust > 1.01) reasons.push("reader-validated source");
  if (inputs.sourceTrust < 0.99) reasons.push("lower reader trust");
  if (inputs.sourceCredibility > 1.01) reasons.push("established editorial source");
  if (inputs.sourceCredibility < 0.99) reasons.push("lower-credibility source");
  if (inputs.sectorTrust > 1.01) reasons.push("strong sector validation");
  if (inputs.sectorTrust < 0.99) reasons.push("weaker sector validation");
  if (corroborationCount > 1) reasons.push(`corroborated by ${corroborationCount} sources`);
  if (inputs.isRehash) reasons.push("similar to recent coverage");
  if (cap) reasons.push("PR-wire score capped");
  if (reasons.length === 0) reasons.push("impact score carried ranking");

  return {
    version: 1,
    baseImpactScore: round(inputs.impactScore),
    relevanceScore: inputs.relevanceScore === undefined ? null : round(inputs.relevanceScore),
    multipliers: {
      sourceTrust: round(inputs.sourceTrust),
      sourceCredibility: round(inputs.sourceCredibility),
      sectorTrust: round(inputs.sectorTrust),
      corroboration: round(corroboration),
      novelty,
    },
    corroborationCount,
    uncappedScore: round(uncappedScore),
    finalScore: round(finalScore),
    cap,
    reasons,
  };
}

export function formatRankingSummary(explanation: RankingExplanation): string {
  return `Ranked ${explanation.finalScore.toFixed(1)} · ${explanation.reasons.slice(0, 3).join(" · ")}`;
}
