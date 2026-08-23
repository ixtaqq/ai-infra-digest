import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dashboard = readFileSync(
  resolve(process.cwd(), "website/dashboard/index.html"),
  "utf8"
);

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
