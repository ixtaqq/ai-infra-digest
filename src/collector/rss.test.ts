import { afterEach, describe, it, expect, vi } from "vitest";

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("matchesKeywords", () => {
  it("should match direct AI keyword in title", async () => {
    const { matchesKeywords } = await import("./rss");
    expect(matchesKeywords("NVIDIA Launches New AI GPU", "")).toBe(true);
  });

  it("should match datacenter keyword in content", async () => {
    const { matchesKeywords } = await import("./rss");
    expect(matchesKeywords("Random Title", "Building a new datacenter in Ohio")).toBe(true);
  });

  it("should match ticker symbol in title", async () => {
    const { matchesKeywords } = await import("./rss");
    expect(matchesKeywords("NVDA Stock Jumps 5%", "")).toBe(true);
  });

  it("should match semiconductor keyword in content", async () => {
    const { matchesKeywords } = await import("./rss");
    expect(matchesKeywords("Title Here", "The semiconductor industry is booming")).toBe(true);
  });

  it("should match earnings keyword", async () => {
    const { matchesKeywords } = await import("./rss");
    expect(matchesKeywords("Earnings Report", "Revenue up 20%")).toBe(true);
  });

  it("should match capex keyword", async () => {
    const { matchesKeywords } = await import("./rss");
    expect(matchesKeywords("Capital expenditure plans", "")).toBe(true);
  });

  it("should not match unrelated articles", async () => {
    const { matchesKeywords } = await import("./rss");
    expect(matchesKeywords("Local Sports Team Wins Championship", "Weather forecast for tomorrow")).toBe(false);
  });

  it("should match case-insensitively", async () => {
    const { matchesKeywords } = await import("./rss");
    expect(matchesKeywords("nvidia launches new gpu", "")).toBe(true);
    expect(matchesKeywords("data center expansion", "")).toBe(true);
  });

  it("should match when keyword is in title but not content", async () => {
    const { matchesKeywords } = await import("./rss");
    expect(matchesKeywords("GPU Breakthrough Announced", "Nothing relevant here")).toBe(true);
  });

  it("should match when keyword is in content but not title", async () => {
    const { matchesKeywords } = await import("./rss");
    expect(matchesKeywords("Interesting News", "The company announced new GPU architecture")).toBe(true);
  });

  it("should match 'HBM' keyword for memory", async () => {
    const { matchesKeywords } = await import("./rss");
    expect(matchesKeywords("HBM3E Memory Production Ramping", "")).toBe(true);
  });

  it("should match 'liquid cooling' keyword", async () => {
    const { matchesKeywords } = await import("./rss");
    expect(matchesKeywords("", "New liquid cooling system for datacenters")).toBe(true);
  });

  it("should match ticker in content", async () => {
    const { matchesKeywords } = await import("./rss");
    expect(matchesKeywords("Market Update", "$AMZN expected to increase cloud capex")).toBe(true);
  });
});

describe("fetchFeedWithStatus", () => {
  it("returns a failed result when the conditional request throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(Math, "random").mockReturnValue(0);

    const { fetchFeedWithStatus } = await import("./rss");
    const result = await fetchFeedWithStatus(
      { name: "Broken feed", url: "https://example.com/broken.xml" },
      5
    );

    expect(result).toMatchObject({
      name: "Broken feed",
      status: "failed",
      articlesFetched: 0,
      error: "network down",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
