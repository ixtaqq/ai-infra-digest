import nodemailer from "nodemailer";
import { config } from "../config";
import { logger } from "../utils/logger";

// Exported for unit tests
export function htmlToEmailHtml(telegramHtml: string): string {
  // Telegram HTML is already valid HTML subset — wrap in a simple template
  const body = telegramHtml
    .replace(/\n/g, "<br>")
    .replace(/<br><br>/g, "</p><p>");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 680px; margin: 0 auto; padding: 24px; color: #1a1a1a; }
  p { line-height: 1.6; margin: 0 0 12px; }
  b { color: #111; }
  code { background: #f4f4f4; padding: 2px 5px; border-radius: 3px; font-size: 0.9em; }
  a { color: #0066cc; }
  hr { border: none; border-top: 1px solid #e0e0e0; margin: 20px 0; }
</style>
</head>
<body>
<p>${body}</p>
</body>
</html>`;
}

export async function sendEmailDigest(
  htmlText: string,
  recipient = config.app.digestEmailTo
): Promise<boolean> {
  const { smtpUser, smtpPass } = config.app;
  if (!smtpUser || !smtpPass || !recipient) return false;

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: { user: smtpUser, pass: smtpPass },
  });

  const date = new Date().toLocaleDateString("en-MY", {
    timeZone: config.app.timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  try {
    await transporter.sendMail({
      from: `"AI Infra Digest" <${smtpUser}>`,
      to: recipient,
      subject: `AI Infrastructure Digest — ${date}`,
      html: htmlToEmailHtml(htmlText),
    });
    logger.info("Email: digest delivered");
    return true;
  } catch (error) {
    logger.warn(`Email delivery failed: ${(error as Error).message}`);
    return false;
  }
}
