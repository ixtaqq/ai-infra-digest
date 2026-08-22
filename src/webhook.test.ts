import { describe, it, expect } from "vitest";
import { decideWebhook, SlidingWindowRateLimiter } from "./webhook";

const PATH = "/telegram/webhook";

describe("decideWebhook", () => {
  it("returns 200 for the GET health check", () => {
    const d = decideWebhook({ method: "GET", url: "/", webhookPath: PATH, rawBody: "" });
    expect(d.status).toBe(200);
    expect(d.update).toBeUndefined();
  });

  it("404s unknown routes", () => {
    const d = decideWebhook({ method: "POST", url: "/nope", webhookPath: PATH, rawBody: "{}" });
    expect(d.status).toBe(404);
    expect(d.update).toBeUndefined();
  });

  it("rejects a POST with a wrong secret token (403) and does not process it", () => {
    const d = decideWebhook({
      method: "POST", url: PATH, webhookPath: PATH,
      secret: "s3cret", secretHeader: "wrong", rawBody: '{"update_id":1}',
    });
    expect(d.status).toBe(403);
    expect(d.update).toBeUndefined();
  });

  it("rejects a POST with a missing secret token when one is configured (403)", () => {
    const d = decideWebhook({
      method: "POST", url: PATH, webhookPath: PATH,
      secret: "s3cret", secretHeader: undefined, rawBody: '{"update_id":1}',
    });
    expect(d.status).toBe(403);
    expect(d.update).toBeUndefined();
  });

  it("accepts and parses a POST carrying the correct secret token", () => {
    const update = { update_id: 1, message: { text: "/help" } };
    const d = decideWebhook({
      method: "POST", url: PATH, webhookPath: PATH,
      secret: "s3cret", secretHeader: "s3cret", rawBody: JSON.stringify(update),
    });
    expect(d.status).toBe(200);
    expect(d.update).toEqual(update);
  });

  it("400s on malformed JSON", () => {
    const d = decideWebhook({
      method: "POST", url: PATH, webhookPath: PATH,
      secret: "s3cret", secretHeader: "s3cret", rawBody: "{not json",
    });
    expect(d.status).toBe(400);
    expect(d.update).toBeUndefined();
  });

  it("rejects updates when no secret is configured", () => {
    const d = decideWebhook({ method: "POST", url: PATH, webhookPath: PATH, rawBody: '{"update_id":2}' });
    expect(d.status).toBe(403);
    expect(d.update).toBeUndefined();
  });

  it("returns 429 before parsing a rate-limited update", () => {
    const d = decideWebhook({
      method: "POST", url: PATH, webhookPath: PATH,
      secret: "s3cret", secretHeader: "s3cret", rawBody: "{not json", rateLimited: true,
    });
    expect(d).toEqual({ status: 429, body: "too many requests" });
  });
});

describe("SlidingWindowRateLimiter", () => {
  it("allows a bounded burst and recovers after the window", () => {
    const limiter = new SlidingWindowRateLimiter(2, 1000);
    expect(limiter.allow("client", 0)).toBe(true);
    expect(limiter.allow("client", 1)).toBe(true);
    expect(limiter.allow("client", 2)).toBe(false);
    expect(limiter.allow("other", 2)).toBe(true);
    expect(limiter.allow("client", 1001)).toBe(true);
  });

  it("bounds tracked clients and admits new clients after stale entries expire", () => {
    const limiter = new SlidingWindowRateLimiter(2, 1000, 2);
    expect(limiter.allow("one", 0)).toBe(true);
    expect(limiter.allow("two", 1)).toBe(true);
    expect(limiter.allow("three", 2)).toBe(false);
    expect(limiter.allow("three", 1001)).toBe(true);
  });
});
