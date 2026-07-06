import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// In-memory fs mock so the cache never touches the real .ai-cache/ directory.
let dirExists = false;
const store = new Map<string, string>();

vi.mock("fs", () => ({
  existsSync: (p: string) => (p.endsWith(".ai-cache") ? dirExists : store.has(p)),
  mkdirSync: () => {
    dirExists = true;
  },
  readFileSync: (p: string) => {
    const v = store.get(p);
    if (v === undefined) throw new Error("ENOENT");
    return v;
  },
  writeFileSync: (p: string, data: string) => {
    store.set(p, data);
  },
  readdirSync: () => [...store.keys()].map((p) => p.split(/[\\/]/).pop()!),
  statSync: () => ({ mtimeMs: Date.now() }),
  unlinkSync: (p: string) => {
    store.delete(p);
  },
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getCached, setCached } from "./ai-cache";
import type { DigestResult } from "../processor/ai";

// Minimal object — the cache only JSON round-trips it, so shape completeness
// beyond identity doesn't matter for these tests.
const sampleResult = { summary: "test digest", articles: [] } as unknown as DigestResult;

beforeEach(() => {
  dirExists = false;
  store.clear();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ai-cache", () => {
  it("returns null on a cache miss", () => {
    expect(getCached(["https://a.com/1"])).toBeNull();
  });

  it("round-trips a stored result (set then get)", () => {
    setCached(["https://a.com/1", "https://a.com/2"], sampleResult);
    const hit = getCached(["https://a.com/1", "https://a.com/2"]);
    expect(hit).not.toBeNull();
    expect(hit?.summary).toBe("test digest");
  });

  it("is insensitive to article-URL order (key is sorted)", () => {
    setCached(["https://a.com/1", "https://a.com/2"], sampleResult);
    // Same URLs, reversed — must resolve to the same cache key
    expect(getCached(["https://a.com/2", "https://a.com/1"])).not.toBeNull();
  });

  it("misses when the URL set differs", () => {
    setCached(["https://a.com/1"], sampleResult);
    expect(getCached(["https://a.com/1", "https://a.com/2"])).toBeNull();
  });

  it("expires an entry older than the 23h TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    setCached(["https://a.com/1"], sampleResult);

    // 22h later → still a hit
    vi.setSystemTime(new Date("2026-01-01T22:00:00Z"));
    expect(getCached(["https://a.com/1"])).not.toBeNull();

    // 24h after write → expired
    vi.setSystemTime(new Date("2026-01-02T00:00:01Z"));
    expect(getCached(["https://a.com/1"])).toBeNull();
  });
});
