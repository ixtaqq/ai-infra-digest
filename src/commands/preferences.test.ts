import { describe, expect, it } from "vitest";
import { isValidEmail, isValidSlackWebhook } from "./preferences";

describe("personal delivery destination validation", () => {
  it("accepts normal email addresses and rejects malformed values", () => {
    expect(isValidEmail("analyst@example.com")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
  });

  it("only accepts Slack Incoming Webhook hosts and paths", () => {
    expect(isValidSlackWebhook("https://hooks.slack.com/services/T/B/secret")).toBe(true);
    expect(isValidSlackWebhook("https://example.com/services/T/B/secret")).toBe(false);
    expect(isValidSlackWebhook("http://hooks.slack.com/services/T/B/secret")).toBe(false);
  });
});
