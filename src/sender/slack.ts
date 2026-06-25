import { config } from "../config";
import { logger } from "../utils/logger";

// Convert Telegram HTML to Slack mrkdwn
function htmlToSlack(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gs, "*$1*")
    .replace(/<i>(.*?)<\/i>/gs, "_$1_")
    .replace(/<code>(.*?)<\/code>/gs, "`$1`")
    .replace(/<a href="(.*?)">(.*?)<\/a>/gs, "<$1|$2>")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export async function sendSlackDigest(htmlText: string): Promise<boolean> {
  const webhookUrl = config.app.slackWebhookUrl;
  if (!webhookUrl) return false;

  const text = htmlToSlack(htmlText);

  // Split into chunks ≤3000 chars (Slack block text limit)
  const chunks: string[] = [];
  const lines = text.split("\n");
  let current = "";
  for (const line of lines) {
    if ((current + "\n" + line).length > 2900) {
      chunks.push(current.trim());
      current = line;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }
  if (current.trim()) chunks.push(current.trim());

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
