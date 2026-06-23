import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Required env vars so config.ts doesn't crash at import time
    env: {
      TELEGRAM_BOT_TOKEN: "test",
      TELEGRAM_CHAT_ID: "test",
      AI_API_KEY: "test",
      AI_PROVIDER: "groq",
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
    },
  },
});
