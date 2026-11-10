import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dashboard = readFileSync(
  resolve(process.cwd(), "website/dashboard/index.html"),
  "utf8"
) + readFileSync(resolve(process.cwd(), "website/dashboard/desk.js"), "utf8");

describe("dashboard privacy boundary", () => {
  it("loads feedback aggregates without requesting or rendering legacy comments", () => {
    expect(dashboard).toContain("digest_feedback_daily");
    expect(dashboard).toContain("FEEDBACK_DAILY_SELECT");
    expect(dashboard).toContain("at least five ratings are received");
    expect(dashboard).not.toContain("feedback_ratings");
    expect(dashboard).not.toContain("allComments");
    expect(dashboard).not.toContain("Recent Comments");
  });

  it("neutralizes spreadsheet formula prefixes in CSV cells", () => {
    expect(dashboard).toMatch(/\^\[=\+\\-@\\t\\r\]/);
    expect(dashboard).toContain("const safe =");
    expect(dashboard).toContain("? `'${raw}` : raw");
  });
});

describe("website security headers", () => {
  const vercel = JSON.parse(readFileSync(resolve(process.cwd(), "website/vercel.json"), "utf8")) as {
    headers: { source: string; headers: { key: string }[] }[];
  };

  it("applies every security header to all paths, including trailing-slash pages", () => {
    // "/:path*" missed "/briefing/" in production on 2026-11-10; "/(.*)" matches every path.
    const catchAll = vercel.headers.find((rule) => rule.source === "/(.*)");
    expect(catchAll?.headers.map((header) => header.key).sort()).toEqual([
      "Content-Security-Policy",
      "Permissions-Policy",
      "Referrer-Policy",
      "X-Content-Type-Options",
      "X-Frame-Options",
    ]);
  });
});
