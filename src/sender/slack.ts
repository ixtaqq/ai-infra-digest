import { config } from "../config";
import { logger } from "../utils/logger";

// Convert Telegram HTML to Slack mrkdwn (exported for unit tests)
export function htmlToSlack(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gs, "*$1*")
    .replace(/<i>(.*?)<\/i>/gs, "_$1_")
    .replace(/<code>(.*?)<\/code>/gs, "`$1`")
    .replace(/<a href="(.*?)">(.*?)<\/a>/gs, "<$1|$2>")
    // Strip remaining HTML tags — but NOT Slack link syntax (<https://...|text>)
    // produced by the anchor conversion above, which also starts with "<".
    .replace(/<\/?(?!https?:)[a-zA-Z][^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** Split text into newline-aligned chunks ≤ maxLen chars (Slack block text limit is 3000). */
export function chunkForSlack(text: string, maxLen = 2900): string[] {
  const chunks: string[] = [];
  const lines = text.split("\n");
  let current = "";
  for (const line of lines) {
    if ((current + "\n" + line).length > maxLen) {
      chunks.push(current.trim());
      current = line;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export async function sendSlackDigest(
  htmlText: string,
  webhookUrl = config.app.slackWebhookUrl
): Promise<boolean> {
  if (!webhookUrl) return false;

  const chunks = chunkForSlack(htmlToSlack(htmlText));

  try {
    for (const chunk of chunks) {
      const resp = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: chunk }),
      });
      if (!resp.ok) {
        logger.warn(`Slack webhook: HTTP ${resp.status}`);
        return false;
      }
    }
    logger.info(`Slack: digest delivered (${chunks.length} message${chunks.length > 1 ? "s" : ""})`);
    return true;
  } catch (error) {
    logger.warn(`Slack delivery failed: ${(error as Error).message}`);
    return false;
  }
}
