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

  it("strips unknown tags and keeps the entities Slack requires", () => {
    expect(htmlToSlack("<blockquote>a &amp; b &lt;c&gt;</blockquote>")).toBe("a &amp; b &lt;c&gt;");
  });

  it("does not turn escaped feed text into a live Slack mention", () => {
    expect(htmlToSlack("&lt;!channel&gt; buy now")).toBe("&lt;!channel&gt; buy now");
  });

  it("decodes quotes that Slack does not treat as entities", () => {
    expect(htmlToSlack("Nvidia&#39;s &quot;Rubin&quot;")).toBe('Nvidia\'s "Rubin"');
  });

  it("handles multi-line bold spans (dotall)", () => {
    expect(htmlToSlack("<b>line1\nline2</b>")).toBe("*line1\nline2*");
  });
});

describe("htmlToSlack control sequences", () => {
  it("cannot rebuild a mention or tag from nested markup", () => {
    for (const hostile of ["<<b>!channel>", "<<x>!channel>", "<<i>script>x", "<scr<b>ipt>x", "</<b>script>x"]) {
      expect(htmlToSlack(hostile)).not.toMatch(/<(?!https?:)/);
    }
    expect(htmlToSlack("<<x>!channel>")).toBe("&lt;!channel>");
  });

  it("keeps links and plain comparisons readable", () => {
    expect(htmlToSlack('<a href="https://x.com/a">T</a> <b>b</b>')).toBe("<https://x.com/a|T> *b*");
    expect(htmlToSlack("&lt;5% vs &gt;3%")).toBe("&lt;5% vs &gt;3%");
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
