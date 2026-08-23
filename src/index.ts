import { logger } from "./utils/logger";
import { startInteractiveBot } from "./sender/telegram";
import { config } from "./config";
import { runPipeline } from "./pipeline/run";
import { registerDigestCommands } from "./commands/register";
import { flushMetrics } from "./utils/metrics";

async function exitAfterMetrics(code: number): Promise<void> {
  await flushMetrics();
  process.exit(code);
}

async function main() {
  logger.info("🚀 AI Infrastructure Daily Digest — Starting");

  // Only the local interactive entry point consumes Telegram updates. The
  // compiled daily pipeline remains send-only and does not register handlers.
  if (config.telegram.mode === "polling") {
    startInteractiveBot({ mode: "polling" });
  }

  const success = await runPipeline();

  // Exit cleanly so the polling loop doesn't keep the process alive in CI
  if (success) {
    await exitAfterMetrics(0);
  } else {
    await exitAfterMetrics(1);
  }
}

if (require.main === module) {
  registerDigestCommands();
  main().catch((error) => {
    logger.error(`Fatal error: ${(error as Error).message}`, { stack: (error as Error).stack });
    exitAfterMetrics(1).catch((flushError) => {
      logger.error(`Failed to flush metrics before exit: ${(flushError as Error).message}`);
      process.exit(1);
    });
  });
}

export { main };
export { registerDigestCommands } from "./commands/register";
export { runPipeline } from "./pipeline/run";
export { generateDigest } from "./pipeline/generate";
export { deliverDigest } from "./delivery/deliver";
export { persistDigestMetrics } from "./pipeline/persist";
export type { FeedResult } from "./collector/rss";
export type { GeneratedDigest } from "./pipeline/types";
