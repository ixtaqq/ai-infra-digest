import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
const sendAdminAlertMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../config", () => ({
  config: {
    app: {
      supabaseUrl: "https://supabase.example.test",
      supabaseServiceKey: "service-key",
    },
  },
}));

vi.mock("./logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../sender/telegram", () => ({
  sendAdminAlert: sendAdminAlertMock,
}));

vi.stubGlobal("fetch", fetchMock);

describe("trust-score cache", () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    sendAdminAlertMock.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reuses fresh values and refetches after expiry", async () => {
    const { getSourceMultipliers } = await import("./trust-scores");

    await getSourceMultipliers();
    await getSourceMultipliers();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(3_600_001);
    await getSourceMultipliers();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps source and sector cache entries bounded while preserving scores", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { rating: "up", articles: { source: "Source A", category: "chips" } },
        { rating: "up", articles: { source: "Source A", category: "chips" } },
        { rating: "down", articles: { source: "Source A", category: "chips" } },
      ],
    });

    const { getTrustScores } = await import("./trust-scores");
    const scores = await getTrustScores();

    expect(scores.source.get("Source A")).toBeCloseTo(1.1);
    expect(scores.sector.get("chips")).toBeCloseTo(1.1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
