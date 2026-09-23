import { config } from "../config";
import { registerCommand, type CommandContext } from "../sender/telegram";
import { supabase } from "../utils/supabase";
import { deserializeDigestPublication } from "../pipeline/publication";
import { personalizeDigest } from "../delivery/personalization";
import { formatDigestTelegram } from "../formatter/telegram";
import { todayInTimezone } from "../utils/helpers";
import { NEWS_CATEGORIES } from "../processor/ai";

async function publishedBriefing(ctx: CommandContext): Promise<string> {
  if (!supabase.isConfigured()) return "The briefing is temporarily unavailable. Please try again later.";
  const parts = ctx.text.trim().split(/\s+/).slice(1);
  const onlyWatchlist = parts.includes("watchlist");
  const sector = parts.find(part => part.startsWith("sector="))?.slice(7).replace(/_/g, " ");
  if (sector && !NEWS_CATEGORIES.some(category => category === sector)) {
    return "Unknown sector. Use /settings to see the available sectors.";
  }
  const prefs = await supabase.getUserPreferences(ctx.chatId);
  if ((onlyWatchlist || prefs?.watchlist_mode === "only") && !prefs?.watchlist?.length) {
    return "Your watchlist is empty. Add tickers with /watchlist NVDA AMD, then try /digest again.";
  }
  const publication = await supabase.getLatestDigestPublication();
  if (!publication) return "The first briefing has not been published yet. Please check back later.";
  const edition = deserializeDigestPublication(publication.payload, [], Date.now(), publication.id);
  const personalized = personalizeDigest(edition.digest, {
    ...prefs, chat_id: ctx.chatId,
    ...(onlyWatchlist ? { watchlist_mode: "only" as const } : {}),
    ...(sector ? { categories_enabled: [sector] } : {}),
  });
  if (!personalized.digest.articles.length) {
    return `No articles in the ${edition.runDate} edition match your filters. Adjust /settings or /watchlist.`;
  }
  const stale = edition.runDate !== todayInTimezone(config.app.timezone);
  const message = formatDigestTelegram(personalized.digest, {
    editionDate: edition.runDate, stockPrices: edition.stockPrices,
    secExtracts: edition.secExtracts, earningsAnalyses: edition.earningsAnalyses,
    whatChanged: edition.whatChanged, deepDive: edition.deepDive,
    personalizationNote: personalized.note, digestLength: personalized.length,
  });
  await supabase.recordProductEvent("briefing_retrieved", ctx.chatId, { publication_id: publication.id });
  return (stale ? "<i>Latest available edition; a newer briefing is not yet available.</i>\n\n" : "") + message;
}

export function registerCoreCommands(): void {
  registerCommand("digest", publishedBriefing);
  registerCommand("last", publishedBriefing);
  registerCommand("sources", async () => {
    if (!supabase.isConfigured()) return "Source health is temporarily unavailable.";
    const rows = await supabase.requiredRows<{ feed_name: string; status: string }>(
      "rpc/latest_feed_health", "select=feed_name,status");
    if (!rows.length) return "Source health has not been recorded yet.";
    const healthy = rows.filter(row => row.status === "success").length;
    return `📡 <b>RSS Feeds (${rows.length})</b>\n\n✅ Healthy: ${healthy}\n❌ Failing: ${rows.length - healthy}\n\n<i>Latest recorded result per feed; collection runs daily.</i>`;
  });
}
