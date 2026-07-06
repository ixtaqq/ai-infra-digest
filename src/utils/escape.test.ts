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

  it("leaves tag-free text untouched", () => {
    expect(stripHtmlTags("plain headline")).toBe("plain headline");
  });

  it("handles an empty string", () => {
    expect(stripHtmlTags("")).toBe("");
  });
});
