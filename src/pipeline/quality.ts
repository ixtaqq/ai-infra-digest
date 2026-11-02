import { sendSlackDigest } from "../sender/slack";
import { escapeHtml } from "../utils/escape";
import { logger } from "../utils/logger";
import { supabase } from "../utils/supabase";
import type { GeneratedDigest } from "./types";

const MIN_QUOTES_TO_JUDGE_MOVEMENT = 5;
const MIN_ARTICLES = 10;
const SEC_WINDOW_EDITIONS = 14;
const MAX_LATENESS_SECONDS = 30 * 60;
const HELD_DELIVERY_GRACE_MS = 30 * 60 * 1000;

export interface EditionObservations {
  priceChanges: number[];
  articleCount: number;
  /** Extract counts per edition, newest first, starting with this edition. */
  secExtractCounts: number[];
  heldDeliveries: number;
  lastDeliveryLatenessSeconds: number | null;
}

export interface QualityIssue {
  id: string;
  detail: string;
}

const QUALITY_RULES: { id: string; detect: (edition: EditionObservations) => string | null }[] = [
  {
    id: "prices_flat",
    detect: ({ priceChanges }) =>
      priceChanges.length >= MIN_QUOTES_TO_JUDGE_MOVEMENT && priceChanges.every((change) => change === 0)
        ? `All ${priceChanges.length} stock quotes show 0% change.`
        : null,
  },
  {
    id: "thin_edition",
    detect: ({ articleCount }) =>
      articleCount < MIN_ARTICLES ? `Only ${articleCount} articles passed the filters.` : null,
  },
  {
    id: "sec_no_extracts",
    detect: ({ secExtractCounts }) =>
      secExtractCounts.length >= SEC_WINDOW_EDITIONS && secExtractCounts.every((count) => count === 0)
        ? `The last ${secExtractCounts.length} editions contain no SEC extract.`
        : null,
  },
  {
    id: "deliveries_held",
    detect: ({ heldDeliveries }) =>
      heldDeliveries > 0
        ? `${heldDeliveries} deliveries await reconciliation. Run npm run operations -- status.`
        : null,
  },
  {
    id: "delivery_late",
    detect: ({ lastDeliveryLatenessSeconds: lateness }) =>
      lateness !== null && lateness > MAX_LATENESS_SECONDS
        ? `The latest delivery was ${Math.round(lateness / 60)} minutes late.`
        : null,
  },
];

export function assessEditionQuality(edition: EditionObservations): QualityIssue[] {
  return QUALITY_RULES.flatMap(({ id, detect }) => {
    const detail = detect(edition);
    return detail ? [{ id, detail }] : [];
  });
}

async function observeHistory(generated: GeneratedDigest): Promise<
  Pick<EditionObservations, "secExtractCounts" | "heldDeliveries" | "lastDeliveryLatenessSeconds">
> {
  const heldBefore = new Date(Date.now() - HELD_DELIVERY_GRACE_MS).toISOString();
  const [editions, held, deliveries] = await Promise.all([
    supabase.requiredRows<{ secExtracts: unknown[] | null }>("digest_publications",
      `publication_date=lt.${encodeURIComponent(generated.runDate)}&select=secExtracts:payload->secExtracts&order=publication_date.desc&limit=${SEC_WINDOW_EDITIONS - 1}`),
    supabase.requiredRows("user_delivery_log",
      `status=in.(pending,ambiguous)&claimed_at=lt.${encodeURIComponent(heldBefore)}&select=id&limit=100`),
    supabase.requiredRows<{ properties: { lateness_seconds?: unknown } | null }>("product_events",
      "event_name=eq.delivery_succeeded&select=properties&order=created_at.desc&limit=1"),
  ]);
  const lateness = deliveries[0]?.properties?.lateness_seconds;
  return {
    secExtractCounts: [generated.secExtracts.length, ...editions.map((row) => row.secExtracts?.length ?? 0)],
    heldDeliveries: held.length,
    lastDeliveryLatenessSeconds: typeof lateness === "number" ? lateness : null,
  };
}

/** Reports what looks wrong with an edition. It never blocks publication. */
export async function reportEditionQuality(generated: GeneratedDigest): Promise<string[]> {
  let history: Awaited<ReturnType<typeof observeHistory>> = {
    secExtractCounts: [], heldDeliveries: 0, lastDeliveryLatenessSeconds: null,
  };
  const issues: QualityIssue[] = [];
  if (supabase.isConfigured()) {
    try {
      history = await observeHistory(generated);
    } catch (error) {
      issues.push({ id: "quality_history_unavailable", detail: `Could not read run history: ${(error as Error).message}` });
    }
  }
  issues.push(...assessEditionQuality({
    priceChanges: [...generated.stockPrices.values()].map((quote) => quote.changePercent),
    articleCount: generated.digest.articles.length,
    ...history,
  }));
  if (issues.length === 0) return [];

  const summary = issues.map((issue) => issue.detail).join(" ");
  logger.error(`Edition quality issues for ${generated.runDate}: ${summary}`);
  try {
    await sendSlackDigest(
      `<b>Edition quality alert, ${escapeHtml(generated.runDate)}</b>\n` +
        issues.map((issue) => `• ${escapeHtml(issue.detail)}`).join("\n")
    );
  } catch (error) {
    logger.error(`Could not send the quality alert: ${(error as Error).message}`);
  }
  return issues.map((issue) => issue.id);
}
