import type { PriceWatch } from "../utils/price-watch";
import type { StockPrice } from "../utils/stocks";
import type { GeneratedDigest } from "./types";
import {
  AI_ANALYSIS_SCHEMA_VERSION,
  AI_PROMPT_VERSION,
} from "../processor/versions";

export const DIGEST_PUBLICATION_SCHEMA_VERSION = 1;

export interface DigestPublicationPayload {
  schemaVersion: number;
  promptVersion: string;
  analysisSchemaVersion: number;
  runDate: string;
  formattedMessage: string;
  digest: GeneratedDigest["digest"];
  articlesCollected: number;
  feedStatuses: GeneratedDigest["feedStatuses"];
  secExtracts: GeneratedDigest["secExtracts"];
  earningsAnalyses: GeneratedDigest["earningsAnalyses"];
  stockPrices: [string, StockPrice][];
  whatChanged?: string;
  deepDive?: GeneratedDigest["deepDive"];
  capabilities: GeneratedDigest["capabilities"];
}

export function serializeDigestPublication(
  generated: GeneratedDigest
): DigestPublicationPayload {
  return {
    schemaVersion: DIGEST_PUBLICATION_SCHEMA_VERSION,
    promptVersion: AI_PROMPT_VERSION,
    analysisSchemaVersion: AI_ANALYSIS_SCHEMA_VERSION,
    runDate: generated.runDate,
    formattedMessage: generated.formattedMessage,
    digest: generated.digest,
    articlesCollected: generated.articlesCollected,
    feedStatuses: generated.feedStatuses,
    secExtracts: generated.secExtracts,
    earningsAnalyses: generated.earningsAnalyses,
    stockPrices: [...generated.stockPrices.entries()],
    whatChanged: generated.whatChanged,
    deepDive: generated.deepDive,
    capabilities: generated.capabilities,
  };
}

function isPublicationPayload(value: unknown): value is DigestPublicationPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<DigestPublicationPayload>;
  return (
    payload.schemaVersion === DIGEST_PUBLICATION_SCHEMA_VERSION &&
    typeof payload.promptVersion === "string" &&
    typeof payload.analysisSchemaVersion === "number" &&
    typeof payload.runDate === "string" &&
    typeof payload.formattedMessage === "string" &&
    !!payload.digest &&
    typeof payload.digest === "object" &&
    typeof payload.articlesCollected === "number" &&
    Array.isArray(payload.feedStatuses) &&
    Array.isArray(payload.secExtracts) &&
    Array.isArray(payload.earningsAnalyses) &&
    Array.isArray(payload.stockPrices) &&
    !!payload.capabilities &&
    typeof payload.capabilities === "object"
  );
}

export function deserializeDigestPublication(
  payload: unknown,
  activeWatches: PriceWatch[],
  startTime = Date.now(),
  publicationId?: number
): GeneratedDigest {
  if (!isPublicationPayload(payload)) {
    throw new Error("Invalid digest publication payload");
  }

  return {
    publicationId,
    runDate: payload.runDate,
    startTime,
    formattedMessage: payload.formattedMessage,
    digest: payload.digest,
    articlesCollected: payload.articlesCollected,
    feedStatuses: payload.feedStatuses,
    secExtracts: payload.secExtracts,
    earningsAnalyses: payload.earningsAnalyses,
    stockPrices: new Map(payload.stockPrices),
    whatChanged: payload.whatChanged,
    deepDive: payload.deepDive,
    activeWatches,
    capabilities: payload.capabilities,
  };
}
