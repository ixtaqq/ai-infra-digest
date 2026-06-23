import TelegramBot from "node-telegram-bot-api";
import { config } from "../config";
import { logger } from "../utils/logger";

let bot: TelegramBot | null = null;

function getBot(): TelegramBot {
  if (!bot) {
    bot = new TelegramBot(config.telegram.botToken, { polling: false });
  }
  return bot;
}

export interface SendResult {
  success: boolean;
  messageId?: number;
  error?: string;
}

export async function sendTelegramMessage(
  text: string,
  parseMode: "HTML" | "MarkdownV2" = "HTML"
): Promise<SendResult> {
  const bot = getBot();

  try {
    const result = await bot.sendMessage(config.telegram.chatId, text, {
      parse_mode: parseMode,
      disable_web_page_preview: false,
    });

    logger.info(`Telegram message sent (ID: ${result.message_id})`);
    return { success: true, messageId: result.message_id };
  } catch (error) {
    const errMsg = (error as Error).message;

    // Handle common Telegram errors
    if (errMsg.includes("chat not found")) {
      logger.error(
        "Chat not found. Make sure you've messaged your bot first or correct TELEGRAM_CHAT_ID"
      );
    } else if (errMsg.includes("bot was blocked")) {
      logger.error("Bot was blocked by the user. Unblock and try again.");
    } else if (errMsg.includes("too long")) {
      logger.error("Message too long for Telegram. Try reducing articles.");
    }

    return { success: false, error: errMsg };
  }
}

export async function sendDigestMessage(
  digestText: string
): Promise<SendResult> {
  logger.info("Sending digest to Telegram...");

  // Telegram has a 4096 character limit; split if needed
  if (digestText.length <= 4096) {
    return sendTelegramMessage(digestText);
  }

  // Split into multiple messages
  const chunks = splitMessage(digestText, 4096);
  let lastResult: SendResult = { success: true };

  for (let i = 0; i < chunks.length; i++) {
    const header = i === 0 ? "" : `📄 Part ${i + 1}/${chunks.length}\n\n`;
    lastResult = await sendTelegramMessage(header + chunks[i]);
    if (!lastResult.success) break;
  }

  return lastResult;
}

function splitMessage(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const line of text.split("\n")) {
    if (current.length + line.length + 1 > maxLen) {
      chunks.push(current.trim());
      current = "";
    }
    current += line + "\n";
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}
