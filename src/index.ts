import { logger } from "./utils/logger";
import { startInteractiveBot } from "./sender/telegram";
import { runPipeline } from "./pipeline/run";
import { registerDigestCommands } from "./commands/register";

async function main() {
  logger.info("🚀 AI Infrastructure Daily Digest — Starting");

  // Start interactive bot (registers /start, /help, etc.)
  startInteractiveBot();

  const success = await runPipeline();

  // Exit cleanly so the polling loop doesn't keep the process alive in CI
  if (success) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

if (require.main === module) {
  registerDigestCommands();
  main().catch((error) => {
    logger.error(`Fatal error: ${(error as Error).message}`, { stack: (error as Error).stack });
    process.exit(1);
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
