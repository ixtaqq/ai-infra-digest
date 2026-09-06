import { describe, expect, it } from "vitest";
import { planMessageParts } from "./message-parts";

describe("complete Telegram parts", () => {
  it("bounds headers and preserves nested HTML, entities and emoji", () => {
    const text = `<b><a href="https://example.com/?x=1&amp;y=2">${"😀 &amp; news ".repeat(1200)}</a></b>`;
    const parts = planMessageParts(text);
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(4096);
      expect(part).toMatch(/<b><a [^>]+>.*<\/a><\/b>$/s);
      expect(part).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    }
    const plain = (value: string) => value.replace(/^📄 Part \d+\/\d+\n\n/, "").replace(/<[^>]+>/g, "");
    expect(parts.map(plain).join("")).toBe(plain(text));
  });
});
