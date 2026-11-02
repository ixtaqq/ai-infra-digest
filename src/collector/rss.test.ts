import { afterEach, describe, it, expect, vi } from "vitest";
import * as fs from "fs";

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
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
  it("aborts stalled response bodies and exhausts the bounded retries", async () => {
    const { fetchFeedWithStatus } = await import("./rss");
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    let aborted = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url, options: RequestInit) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => new Promise<string>((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => {
          aborted++;
          reject(new Error("Feed body timed out"));
        }, { once: true });
      }),
    })));

    const pending = fetchFeedWithStatus({ name: "Stalled", url: "https://example.com/stalled" }, 5);
    await vi.advanceTimersByTimeAsync(45_010);
    expect(aborted).toBe(3);
    await expect(pending).resolves.toMatchObject({ status: "failed", error: "Feed body timed out" });
  });

  it("preserves the HTTP failure status in feed diagnostics", async () => {
    const { fetchFeedWithStatus } = await import("./rss");
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    await expect(fetchFeedWithStatus({ name: "Unavailable", url: "https://example.com/unavailable" }, 5))
      .resolves.toMatchObject({ status: "failed", error: "HTTP 503" });
  });

  it("resets cached failure history when an unchanged feed recovers", async () => {
    const feed = { name: "Recovered", url: "https://example.com/recovered" };
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({
      [feed.url]: { etag: "old", lastModified: "yesterday", consecutiveFailures: 2 },
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 304, headers: { ETag: "new" } })));
    const { fetchFeedWithStatus } = await import("./rss");

    await expect(fetchFeedWithStatus(feed, 5)).resolves.toMatchObject({ status: "success", articlesFetched: 0 });
    expect(fs.writeFileSync).toHaveBeenCalled();
    const contents = vi.mocked(fs.writeFileSync).mock.calls.at(-1)![1];
    expect(JSON.parse(String(contents))[feed.url]).toEqual({ etag: "new", lastModified: "yesterday", consecutiveFailures: 0 });
  });

  it("parses the successful response body without fetching the feed a second time", async () => {
    const rss = `<?xml version="1.0"?>
      <rss version="2.0"><channel><title>Example</title>
        <item><title>New GPU announcement</title><link>https://example.com/gpu</link>
          <description>AI infrastructure update</description>
        </item>
      </channel></rss>`;
    const fetchMock = vi.fn().mockResolvedValue(new Response(rss, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { fetchFeedWithStatus } = await import("./rss");
    const result = await fetchFeedWithStatus(
      { name: "Example feed", url: "https://example.com/feed.xml" },
      5
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("success");
    expect(result.articles).toMatchObject([
      {
        title: "New GPU announcement",
        url: "https://example.com/gpu",
        contentSnippet: "AI infrastructure update",
      },
    ]);
  });

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

describe("collectArticles", () => {
  it("caps the number of feeds fetched concurrently", async () => {
    const rss = `<?xml version="1.0"?>
      <rss version="2.0"><channel><title>Example</title>
        <item><title>GPU infrastructure update</title><link>https://example.com/gpu</link></item>
      </channel></rss>`;
    let active = 0;
    let peak = 0;
    const fetchMock = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return new Response(rss, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { collectArticles, RSS_FETCH_CONCURRENCY } = await import("./rss");
    const result = await collectArticles();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(RSS_FETCH_CONCURRENCY);
    expect(peak).toBeLessThanOrEqual(RSS_FETCH_CONCURRENCY);
    expect(result.feedStatuses).toHaveLength(fetchMock.mock.calls.length);
    expect(result.feedStatuses.every((feed) => feed.status === "success")).toBe(true);
  });
});

describe("untrusted feed fields", () => {
  async function fetchItem(item: string) {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title><item>${item}</item></channel></rss>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(rss, { status: 200 })));
    const { fetchFeedWithStatus } = await import("./rss");
    return fetchFeedWithStatus({ name: "Example feed", url: "https://example.com/feed.xml" }, 5);
  }

  it("replaces an unparseable pubDate so the edition can still serialize", async () => {
    const result = await fetchItem("<title>GPU news</title><link>https://example.com/a</link><pubDate>not a date</pubDate>");
    expect(Number.isNaN(result.articles[0].date.getTime())).toBe(false);
  });

  it("drops a non-http article link", async () => {
    const result = await fetchItem("<title>GPU news</title><link>javascript:alert(1)</link>");
    expect(result.articles[0].url).toBe("");
  });
});

describe("matchesKeywords ticker matching", () => {
  it.each(["Better butter recipes", "How much is too much", "Life on the farm", "What to read now", "A social club"])(
    "does not treat a ticker as a substring of %s", async (title) => {
      const { matchesKeywords } = await import("./rss");
      expect(matchesKeywords(title, "")).toBe(false);
    });

  it("matches AI as its own word but not inside other words", async () => {
    const { matchesKeywords } = await import("./rss");
    expect(matchesKeywords("Is this the first clear evidence of AI's impact?", "")).toBe(true);
    expect(matchesKeywords("Fans wait for the rain to stop", "")).toBe(false);
  });

  it("still matches the ticker as its own word", async () => {
    const { matchesKeywords } = await import("./rss");
    expect(matchesKeywords("MU beats estimates", "")).toBe(true);
    expect(matchesKeywords("Shares of (TT) rose", "")).toBe(true);
  });
});
