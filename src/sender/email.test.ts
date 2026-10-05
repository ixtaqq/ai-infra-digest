import { afterEach, describe, it, expect, vi } from "vitest";
import nodemailer from "nodemailer";
import { config } from "../config";

vi.mock("../config", () => ({
  config: { app: { smtpUser: undefined, smtpPass: undefined, digestEmailTo: undefined, timezone: "UTC" } },
}));

vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { htmlToEmailHtml, sendEmailDigest, sendEmailVerification } from "./email";

afterEach(() => {
  vi.restoreAllMocks();
  config.app.smtpUser = undefined;
  config.app.smtpPass = undefined;
});

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

describe("offline mail composition", () => {
  it("composes digest and verification messages with the installed Nodemailer", async () => {
    config.app.smtpUser = "sender@example.com";
    config.app.smtpPass = "fixture";
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const sendMail = vi.spyOn(transport, "sendMail");
    vi.spyOn(nodemailer, "createTransport").mockReturnValue(transport);

    await expect(sendEmailDigest("<b>GPU capacity</b>", "reader@example.com")).resolves.toBe(true);
    await expect(sendEmailVerification("reader@example.com", "123456")).resolves.toBe(true);

    const [digest, verification] = await Promise.all(sendMail.mock.results.map(result => result.value));
    expect(digest.envelope.to).toEqual(["reader@example.com"]);
    expect(digest.message.toString()).toContain("<b>GPU capacity</b>");
    expect(verification.message.toString()).toContain("123456");
  });
});
