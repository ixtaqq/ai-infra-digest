import { describe, it, expect, vi } from "vitest";

vi.mock("../config", () => ({
  config: { app: { slackWebhookUrl: undefined } },
}));

vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { htmlToSlack, chunkForSlack } from "./slack";

describe("htmlToSlack", () => {
  it("converts bold, italic, and code tags to mrkdwn", () => {
    expect(htmlToSlack("<b>bold</b> <i>italic</i> <code>code</code>")).toBe("*bold* _italic_ `code`");
  });

  it("converts anchors to Slack link syntax", () => {
    expect(htmlToSlack('<a href="https://x.com/a">Title</a>')).toBe("<https://x.com/a|Title>");
  });

  it("strips unknown tags and unescapes entities", () => {
    expect(htmlToSlack("<blockquote>a &amp; b &lt;c&gt;</blockquote>")).toBe("a & b <c>");
  });

  it("handles multi-line bold spans (dotall)", () => {
    expect(htmlToSlack("<b>line1\nline2</b>")).toBe("*line1\nline2*");
  });
});

describe("chunkForSlack", () => {
  it("returns a single chunk for short text", () => {
    expect(chunkForSlack("hello\nworld")).toEqual(["hello\nworld"]);
  });

  it("splits on newline boundaries when exceeding the limit", () => {
    const lineA = "a".repeat(60);
    const lineB = "b".repeat(60);
    const chunks = chunkForSlack(`${lineA}\n${lineB}`, 100);
    expect(chunks).toEqual([lineA, lineB]);
  });

  it("keeps every chunk within the limit", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${"x".repeat(80)}`).join("\n");
    const chunks = chunkForSlack(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
    // No content lost
    expect(chunks.join("\n")).toBe(text);
  });

  it("drops trailing whitespace-only remainder", () => {
    expect(chunkForSlack("content\n   ")).toEqual(["content"]);
  });
});
