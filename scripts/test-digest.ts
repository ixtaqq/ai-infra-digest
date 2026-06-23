/**
 * Test script to run the AI Infrastructure Digest manually.
 * This is useful for testing before setting up the cron schedule.
 *
 * Usage:
 *   npm run test-digest
 *
 * Make sure you have a .env file with the required environment variables.
 */

import { config } from "../src/config";
import { logger } from "../src/utils/logger";
import { main } from "../src/index";

async function testDigest() {
  // Validate config before running
  const required = [
    ["TELEGRAM_BOT_TOKEN", config.telegram.botToken],
    ["TELEGRAM_CHAT_ID", config.telegram.chatId],
    ["AI_API_KEY", config.ai.apiKey],
  ];

  const missing = required.filter(([name, val]) => !val);
  if (missing.length > 0) {
    console.error(
      `\n❌ Missing required environment variables:\n` +
        missing.map(([name]) => `   - ${name}`).join("\n") +
        `\n\nCopy .env.example to .env and fill in the values.\n`
    );
    process.exit(1);
  }

  console.log("");
  console.log("╔═══════════════════════════════════════╗");
  console.log("║  🚀 AI Infra Digest — Test Run        ║");
  console.log(`║  Provider: ${config.ai.provider.padEnd(22)}║`);
  console.log(`║  Model:    ${config.ai.model.padEnd(22)}║`);
  console.log("╚═══════════════════════════════════════╝");
  console.log("");

  const startTime = Date.now();

  try {
    await main();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ Test run completed in ${elapsed}s`);
  } catch (error) {
    console.error("\n❌ Test run failed:", (error as Error).message);
    process.exit(1);
  }
}

testDigest();
