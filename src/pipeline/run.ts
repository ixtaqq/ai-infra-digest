import { config } from "../config";
import { deliverDigest } from "../delivery/deliver";
import { sendValidationFollowUp } from "../sender/telegram";
import { logger } from "../utils/logger";
import { supabase } from "../utils/supabase";
import { withAIAccounting } from "../utils/ai-accounting";
import { generateDigest } from "./generate";
import { persistDigestMetrics } from "./persist";
import {
  deserializeDigestPublication,
  serializeDigestPublication,
} from "./publication";

export async function runPipeline(targetChatId?: number): Promise<boolean> {
  return withAIAccounting(() => runEditorialPipeline(targetChatId));
}

async function runEditorialPipeline(targetChatId?: number): Promise<boolean> {
  const generated = await generateDigest();
  if (!generated) return false;

  // The editorial run is persisted and published before any channel delivery.
  // Schedulers consume this immutable edition and never repeat the AI pipeline.
  const complete = async (success: boolean) => {
    if (generated.digestRunId && !await supabase.completeDigestRun(generated.digestRunId,
      success ? "success" : "failed", success ? undefined : "Publication or delivery incomplete")) {
      throw new Error("Run finalization failed");
    }
    if (generated.digestRunId && !await supabase.updateDailyMetrics(generated.runDate,
      { digest_status: success ? "success" : "failed" })) {
      throw new Error("Daily run status finalization failed");
    }
    return success;
  };
  try {
    const articleIds = await persistDigestMetrics(generated, "running");
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
        return complete(false);
      }

      const publicationId = await supabase.createDigestPublication(
        generated.runDate,
        serializeDigestPublication(generated) as unknown as Record<string, unknown>,
        articleIds
      );
      if (!publicationId) {
        logger.error(`Canonical publication failed for ${generated.runDate} — delivery withheld`);
        return complete(false);
      }

      const canonical = await supabase.getDigestPublication(generated.runDate);
      if (!canonical || canonical.id !== publicationId) {
        logger.error(`Canonical publication could not be reloaded for ${generated.runDate}`);
        return complete(false);
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
        return complete(false);
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
        sendResult = await deliverDigest(deliveryEdition, undefined, undefined, undefined, (result) =>
          supabase.logUserDelivery(defaultChatId, generated.runDate,
            result.success ? "success" : result.ambiguous ? "ambiguous" : "failed",
            result.error, deliveryEdition.publicationId));
        delivered = true;
      } else {
        sendResult = await supabase.wasUserDeliveredToday(defaultChatId, generated.runDate)
          ? { success: true }
          : { success: false, ambiguous: true, error: "Default delivery claim requires reconciliation" };
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

    const succeeded = await complete(sendResult.success);
    logger.info(succeeded ? "Digest pipeline completed" : "Digest pipeline incomplete");
    return succeeded;
  } catch (error) {
    await complete(false);
    throw error;
  }
}
