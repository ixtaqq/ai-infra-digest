import { describe, it, expect } from "vitest";
import { escapeHtml, stripHtmlTags } from "./escape";

describe("escapeHtml", () => {
  it("escapes all five HTML-significant characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("escapes ampersand first so entities are not double-mangled", () => {
    // If < were escaped before &, the &lt; would become &amp;lt;
    expect(escapeHtml("a < b")).toBe("a &lt; b");
    expect(escapeHtml("Tom & Jerry")).toBe("Tom &amp; Jerry");
  });

  it("neutralizes a script-injection payload", () => {
    expect(escapeHtml(`<script>alert('x')</script>`)).toBe(
      "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"
    );
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeHtml("NVDA capex up 32% WoW")).toBe("NVDA capex up 32% WoW");
  });

  it("handles an empty string", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("stripHtmlTags", () => {
  it("removes tags but keeps their text content", () => {
    expect(stripHtmlTags("<b>bold</b> and <i>italic</i>")).toBe("bold and italic");
  });

  it("strips a hostile tag entirely", () => {
    expect(stripHtmlTags(`hi<script>evil()</script>there`)).toBe("hievil()there");
  });

  it("does not reassemble a tag from nested markup", () => {
    expect(stripHtmlTags("<<b>script>alert(1)<</b>/script>")).toBe("alert(1)");
    expect(stripHtmlTags("<scr<b>ipt>x")).toBe("x");
    expect(stripHtmlTags("</<b>script>x")).toBe("x");
  });

  it("gives the same result when applied twice", () => {
    for (const input of ["<<<b>b>b>x", "<a<b>c>d", "<5<b>x>", "a<b>c>d", "<<b>/i>x"]) {
      const once = stripHtmlTags(input);
      expect(stripHtmlTags(once)).toBe(once);
    }
  });

  it("keeps comparison text that only looks like a tag", () => {
    expect(stripHtmlTags("Revenue <5% vs >3%")).toBe("Revenue <5% vs >3%");
  });

  it("leaves tag-free text untouched", () => {
    expect(stripHtmlTags("plain headline")).toBe("plain headline");
  });

  it("handles an empty string", () => {
    expect(stripHtmlTags("")).toBe("");
  });
});
