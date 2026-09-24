import { createHash } from "node:crypto";
import { sendDigestMessageToUser } from "../sender/telegram";
import { escapeHtml } from "../utils/escape";
import { isFreshQuote, isTriggered, type PriceWatch } from "../utils/price-watch";
import { fetchStockPrices } from "../utils/stocks";
import { supabase } from "../utils/supabase";

export async function deliverPriceWatches(chatId: number, watches: PriceWatch[]): Promise<void> {
  const owned = watches.filter(watch => watch.chat_id === chatId);
  if (!owned.length) return;
  const quotes = await fetchStockPrices(owned.map(watch => watch.ticker));
  for (const watch of owned) {
    const quote = quotes.get(watch.ticker);
    if (!quote || !isFreshQuote(quote) || !isTriggered(watch, quote.price)) continue;
    const identity = createHash("sha256").update(`watch:${watch.id}:${watch.revision ?? watch.created_at}`).digest("hex");
    if (!await supabase.claimHighImpactAlert(chatId, identity)) continue;
    const result = await sendDigestMessageToUser(chatId,
      `🔔 <b>Price Watch</b>\n\n<b>${escapeHtml(watch.ticker)}</b> is ${watch.direction === "above" ? "at or above" : "at or below"} $${watch.threshold}.\n` +
      `Observed $${quote.price.toFixed(2)} at ${escapeHtml(quote.observedAt!)}.\n<i>Sampled at daily delivery; not a real-time crossing alert.</i>`);
    if (!await supabase.logHighImpactAlert(chatId, identity,
      result.success ? "success" : result.ambiguous ? "ambiguous" : "failed", result.error)) {
      throw new Error("Watch finalization failed; do not replay automatically");
    }
    if (result.success && watch.revision) await supabase.completePriceWatch(watch.id, watch.revision);
  }
}
