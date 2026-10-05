import { config } from "../config";
import type { GeneratedDigest } from "../pipeline/types";
import type { SendResult } from "../sender/telegram";
import { supabase } from "../utils/supabase";
import { logger } from "../utils/logger";
import { deliverDigest } from "./deliver";

export async function deliverDefaultPublication(generated: GeneratedDigest): Promise<{ result: SendResult; delivered: boolean }> {
  const chat = Number(config.telegram.chatId);
  if (!Number.isSafeInteger(chat) || chat === 0) throw new Error("Invalid default delivery chat");
  if (!generated.publicationId) throw new Error("Default delivery requires a canonical publication");
  const date = generated.runDate;
  if (!await supabase.claimUserDelivery(chat, date)) {
    const succeeded = await supabase.wasUserDeliveredToday(chat, date);
    return {
      delivered: false,
      result: succeeded ? { success: true } : { success: false, ambiguous: true, error: "Default delivery claim requires reconciliation" },
    };
  }
  const result = await deliverDigest(generated, undefined, undefined, undefined, result =>
    supabase.logUserDelivery(chat, date, result.success ? "success" : result.ambiguous ? "ambiguous" : "failed", result.error, generated.publicationId));
  logger.info("Default digest delivery timing", {
    event: "default_delivery_timing", editorial_date: date, publication_id: generated.publicationId,
    completed_at: new Date().toISOString(), status: result.success ? "success" : result.ambiguous ? "ambiguous" : "failed",
  });
  return { result, delivered: true };
}
