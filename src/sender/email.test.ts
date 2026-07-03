import { describe, it, expect, vi } from "vitest";

vi.mock("../config", () => ({
  config: { app: { smtpUser: undefined, smtpPass: undefined, digestEmailTo: undefined, timezone: "UTC" } },
}));

vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { htmlToEmailHtml, sendEmailDigest } from "./email";

describe("htmlToEmailHtml", () => {
  it("wraps content in a full HTML document", () => {
    const out = htmlToEmailHtml("<b>Digest</b>");
    expect(out).toContain("<!DOCTYPE html>");
    expect(out).toContain("<b>Digest</b>");
    expect(out).toContain("</html>");
  });

  it("converts newlines to <br> and double breaks to paragraphs", () => {
    const out = htmlToEmailHtml("para one\n\npara two\nline two");
    expect(out).toContain("para one</p><p>para two<br>line two");
  });
});

describe("sendEmailDigest", () => {
  it("returns false without sending when SMTP credentials are not configured", async () => {
    const result = await sendEmailDigest("<b>test</b>");
    expect(result).toBe(false);
  });
});
