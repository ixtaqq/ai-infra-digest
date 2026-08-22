import { config } from "../config";
import { deliverDigest } from "../delivery/deliver";
import { sendValidationFollowUp } from "../sender/telegram";
import { logger } from "../utils/logger";
import { supabase } from "../utils/supabase";
import { generateDigest } from "./generate";
import { persistDigestMetrics } from "./persist";
import {
  deserializeDigestPublication,
  serializeDigestPublication,
} from "./publication";

export async function runPipeline(targetChatId?: number): Promise<boolean> {
  const generated = await generateDigest();
  if (!generated) return false;

  // The editorial run is persisted and published before any channel delivery.
  // Schedulers consume this immutable edition and never repeat the AI pipeline.
  const articleIds = await persistDigestMetrics(generated, "success");
  let deliveryEdition = generated;
  let publicationArticleIds = articleIds;
  if (supabase.isConfigured()) {
    const expectedArticleIds = new Set(
      generated.digest.articles.map((article) => article.url).filter(Boolean)
    ).size;
    if (articleIds.size !== expectedArticleIds) {
      logger.error(
        `Canonical publication withheld: persisted ${articleIds.size}/${expectedArticleIds} article identities`
      );
      return false;
    }

    const publicationId = await supabase.createDigestPublication(
      generated.runDate,
      serializeDigestPublication(generated) as unknown as Record<string, unknown>,
      articleIds
    );
    if (!publicationId) {
      logger.error(`Canonical publication failed for ${generated.runDate} — delivery withheld`);
      return false;
    }

    const canonical = await supabase.getDigestPublication(generated.runDate);
    if (!canonical || canonical.id !== publicationId) {
      logger.error(`Canonical publication could not be reloaded for ${generated.runDate}`);
      return false;
    }
    try {
      deliveryEdition = deserializeDigestPublication(
        canonical.payload,
        generated.activeWatches,
        generated.startTime,
        canonical.id
      );
      publicationArticleIds = new Map(
        Object.entries(canonical.article_ids || {}).filter(
          (entry): entry is [string, number] => typeof entry[1] === "number"
        )
      );
    } catch (error) {
      logger.error(
        `Canonical publication #${canonical.id} is invalid: ${(error as Error).message}`
      );
      return false;
    }
  }

  let delivered = false;
  let sendResult: Awaited<ReturnType<typeof deliverDigest>> = { success: true };
  const defaultChatId = Number(config.telegram.chatId);
  const shouldClaimDefault =
    targetChatId === undefined &&
    supabase.isConfigured() &&
    deliveryEdition.publicationId !== undefined &&
    Number.isSafeInteger(defaultChatId) &&
    defaultChatId > 0;

  if (shouldClaimDefault) {
    const claimed = await supabase.claimUserDelivery(defaultChatId, generated.runDate);
    if (claimed) {
      sendResult = await deliverDigest(deliveryEdition);
      delivered = true;
      await supabase.logUserDelivery(
        defaultChatId,
        generated.runDate,
        sendResult.success ? "success" : "failed",
        sendResult.error,
        deliveryEdition.publicationId
      );
    } else {
      logger.info(
        `Default chat already owns delivery for ${generated.runDate} — duplicate send skipped`
      );
    }
  } else {
    sendResult = await deliverDigest(deliveryEdition, targetChatId);
    delivered = true;
  }

  if (delivered && sendResult.success && publicationArticleIds.size > 0) {
    const chatId = targetChatId ?? (config.telegram.chatId ? Number(config.telegram.chatId) : undefined);
    if (chatId) {
      try {
        await sendValidationFollowUp(
          chatId,
          deliveryEdition.digest.articles,
          publicationArticleIds
        );
      } catch {
        // Non-critical — digest already delivered
      }
    }
  }

  logger.info("✅ Digest pipeline completed");
  return sendResult.success;
}
