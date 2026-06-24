/**
 * Static source credibility tiers — deterministic source-name → multiplier map.
 *
 * Provides immediate ranking signal from day one, before any 👍/👎 votes
 * accumulate. Multiplies with the vote-learned trust multiplier and the
 * corroboration multiplier to form `effectiveScore`.
 *
 * Tiers:
 *   High (1.2x) — established, independent editorial with editorial standards
 *   Neutral (1.0x) — specialist/trade press (implicit default, not listed)
 *   Low (0.8x)  — first-party vendor PR or unverified single-outlet
 *
 * Keys must match the `source` field on ProcessedArticle (the RSS feed name
 * string, e.g., "TechCrunch"), not a URL domain.
 */

/** PR wire distribution services — press releases, not independent reporting. */
const PR_WIRE_SOURCES = new Set([
  "Business Wire",
  "BusinessWire",
  "PR Newswire",
  "PRNewswire",
  "Globe Newswire",
  "GlobeNewswire",
  "Businesswire",
  "PR Web",
  "PRWeb",
  "EIN Presswire",
  "AccessWire",
]);

/** Returns true if the source is a PR wire distribution service. */
export function isPRWireSource(sourceName: string): boolean {
  return PR_WIRE_SOURCES.has(sourceName);
}

const SOURCE_CREDIBILITY: Record<string, number> = {
  // ── High-tier: independent, well-resourced editorial ──
  "TechCrunch": 1.2,
  "Ars Technica": 1.2,
  "The Register": 1.2,
  "Tom's Hardware": 1.2,
  "VentureBeat": 1.2,
  "The Verge": 1.2,
  "AnandTech": 1.2,
  "IEEE Spectrum": 1.2,
  "Bloomberg Technology": 1.2,
  "Bloomberg Tech": 1.2,
  "Reuters Technology": 1.2,
  "Reuters": 1.2,
  "Financial Times": 1.2,
  "FT Tech": 1.2,
  "Wall Street Journal": 1.2,
  "WSJ Markets": 1.2,
  "CNBC": 1.2,
  "Barron's": 1.2,
  "Seeking Alpha": 1.2,
  "MarketWatch": 1.2,
  "Semiconductor Engineering": 1.2,
  "SemiAnalysis": 1.2,
  "Datacenter Dynamics": 1.2,
  "Data Center Dynamics": 1.2,

  // ── Low-tier: PR wire services (press releases, not independent reporting) ──
  "Business Wire": 0.8,
  "BusinessWire": 0.8,
  "PR Newswire": 0.8,
  "PRNewswire": 0.8,
  "Globe Newswire": 0.8,
  "GlobeNewswire": 0.8,
  "PR Web": 0.8,
  "PRWeb": 0.8,
  "EIN Presswire": 0.8,
  "AccessWire": 0.8,

  // ── Low-tier: first-party vendor PR ──
  "NVIDIA": 0.8,
  "NVIDIA Newsroom": 0.8,
  "AMD": 0.8,
  "Intel": 0.8,
  "Microsoft": 0.8,
  "Amazon": 0.8,
  "Google": 0.8,
  "Google AI Blog": 0.8,
  "AWS AI": 0.8,
  "OpenAI": 0.8,
  "Anthropic": 0.8,
  "xAI": 0.8,
  "Mistral AI": 0.8,
  "Cohere": 0.8,
  "Meta": 0.8,
  "Apple": 0.8,
  "TSMC": 0.8,
  "Broadcom": 0.8,
  "Qualcomm": 0.8,
  "Oracle": 0.8,
  "IBM": 0.8,
  "Micron": 0.8,
  "ASML": 0.8,
  "Super Micro": 0.8,
  "Dell": 0.8,
  "ARM": 0.8,
  "Arista": 0.8,
  "Cisco": 0.8,
  "Marvell": 0.8,
  "Applied Materials": 0.8,
  "Lam Research": 0.8,
  "KLA": 0.8,
  "Digital Realty": 0.8,
  "Equinix": 0.8,
  "Vertiv": 0.8,
};

/** Return the credibility multiplier for an article's source name. */
export function getSourceCredibility(sourceName: string): number {
  return SOURCE_CREDIBILITY[sourceName] ?? 1.0;
}
