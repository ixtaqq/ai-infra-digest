import { config } from "../config";
import { deliverDigest } from "../delivery/deliver";
import { sendValidationFollowUp } from "../sender/telegram";
import { logger } from "../utils/logger";
import { generateDigest } from "./generate";
import { persistDigestMetrics } from "./persist";

export async function runPipeline(targetChatId?: number): Promise<boolean> {
  const generated = await generateDigest();
  if (!generated) return false;

  const sendResult = await deliverDigest(generated, targetChatId);
  const articleIds = await persistDigestMetrics(
    generated,
    sendResult.success ? "success" : "failed",
    sendResult.error
  );

  if (sendResult.success && articleIds.size > 0) {
    const chatId = targetChatId ?? (config.telegram.chatId ? Number(config.telegram.chatId) : undefined);
    if (chatId) {
      try {
        await sendValidationFollowUp(chatId, generated.digest.articles, articleIds);
      } catch {
        // Non-critical — digest already delivered
      }
    }
  }

  logger.info("✅ Digest pipeline completed");
  return sendResult.success;
}
