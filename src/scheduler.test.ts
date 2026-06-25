import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";

vi.mock("./utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./utils/supabase", () => ({
  supabase: { isConfigured: () => false, getAllActiveUsers: async () => [] },
}));

vi.mock("./config", () => {
  const os = require("os") as typeof import("os");
  const path = require("path") as typeof import("path");
  return {
    config: {
      app: {
        timezone: "Asia/Kuala_Lumpur",
        cacheDir: path.join(os.tmpdir(), "ai-infra-test"),
        maxArticlesPerSource: 5,
        supabaseUrl: "",
        supabaseServiceKey: "",
        budgetDailyUsd: 0.5,
        budgetMonthlyUsd: 5,
      },
      telegram: { botToken: "test", chatId: "0" },
      ai: { provider: "groq", apiKey: "test", model: "test", fastModel: "test", embeddingApiKey: "", embeddingModel: "test" },
    },
  };
});

beforeAll(() => {
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
});

afterEach(() => vi.restoreAllMocks());

describe("isTimeMatch", () => {
  it("matches exact time", async () => {
    const { isTimeMatch } = await import("./scheduler");
    // Stub getCurrentTimeInTimezone by controlling Date
    vi.setSystemTime(new Date("2026-01-01T08:00:00+08:00"));
    expect(isTimeMatch("08:00", "Asia/Kuala_Lumpur")).toBe(true);
  });

  it("matches time within +1 minute window", async () => {
    const { isTimeMatch } = await import("./scheduler");
    vi.setSystemTime(new Date("2026-01-01T08:01:00+08:00"));
    expect(isTimeMatch("08:00", "Asia/Kuala_Lumpur")).toBe(true);
  });

  it("does not match time outside window", async () => {
    const { isTimeMatch } = await import("./scheduler");
    vi.setSystemTime(new Date("2026-01-01T08:05:00+08:00"));
    expect(isTimeMatch("08:00", "Asia/Kuala_Lumpur")).toBe(false);
  });
});
