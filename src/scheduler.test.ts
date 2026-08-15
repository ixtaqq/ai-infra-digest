import { describe, it, expect, vi, afterEach } from "vitest";

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

afterEach(() => vi.restoreAllMocks());

describe("isDeliveryDue", () => {
  it("is due at the preferred local time", async () => {
    const { isDeliveryDue } = await import("./scheduler");
    expect(
      isDeliveryDue("08:00", "Asia/Kuala_Lumpur", new Date("2026-01-01T00:00:00Z"))
    ).toBe(true);
  });

  it("stays due when a cron run is delayed", async () => {
    const { isDeliveryDue } = await import("./scheduler");
    expect(
      isDeliveryDue("08:00", "Asia/Kuala_Lumpur", new Date("2026-01-01T00:45:00Z"))
    ).toBe(true);
  });

  it("is not due before the preferred local time", async () => {
    const { isDeliveryDue } = await import("./scheduler");
    expect(
      isDeliveryDue("08:00", "Asia/Kuala_Lumpur", new Date("2025-12-31T23:59:00Z"))
    ).toBe(false);
  });

  it("does not carry a late-night schedule across the local midnight", async () => {
    const { isDeliveryDue } = await import("./scheduler");
    expect(
      isDeliveryDue("23:00", "Asia/Kuala_Lumpur", new Date("2026-01-01T16:30:00Z"))
    ).toBe(false);
  });
});

describe("getDeliveryDate", () => {
  it("uses the user's local calendar date", async () => {
    const { getDeliveryDate } = await import("./scheduler");
    expect(getDeliveryDate("Asia/Kuala_Lumpur", new Date("2026-01-01T16:30:00Z"))).toBe("2026-01-02");
  });
});
