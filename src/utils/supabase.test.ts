import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({
  config: {
    app: {
      supabaseUrl: "https://mock.supabase.co",
      supabaseServiceKey: "mock-service-key",
    },
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { supabase } from "./supabase";

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, status: 204 });
});

describe("deleteUserData boundary", () => {
  it("deletes chat-owned private rows through one transactional RPC", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => true });
    await expect(supabase.deleteUserData(42)).resolves.toBe(true);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/rest/v1/rpc/delete_user_data");
    expect(options.method).toBe("POST");
    expect(JSON.parse(String(options.body))).toEqual({ p_chat_id: 42 });
  });

  it("reports false when the transactional boundary fails", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

    await expect(supabase.deleteUserData(42)).resolves.toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an unsafe chat id before making a request", async () => {
    await expect(supabase.deleteUserData(Number.NaN)).resolves.toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("digest feedback boundary", () => {
  it("submits feedback through the service-only transactional RPC", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => true });

    await expect(
      supabase.submitDigestFeedback(42, "2026-08-23", 5, "Great coverage")
    ).resolves.toBe(true);

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/rest/v1/rpc/submit_digest_feedback");
    expect(options.method).toBe("POST");
    expect(JSON.parse(String(options.body))).toEqual({
      p_chat_id: 42,
      p_feedback_date: "2026-08-23",
      p_rating: 5,
      p_comment: "Great coverage",
    });
  });

  it("rejects malformed feedback before making a request", async () => {
    await expect(
      supabase.submitDigestFeedback(42, "2026-08-23", 6, "bad rating")
    ).resolves.toBe(false);
    await expect(
      supabase.submitDigestFeedback(42, "2026-08-23", 4, "x".repeat(2001))
    ).resolves.toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("high-impact alert idempotency boundary", () => {
  it("claims a user/article hash through the service-only RPC", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => true,
    });
    const hash = "a".repeat(64);

    await expect(supabase.claimHighImpactAlert(42, hash)).resolves.toBe(true);

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/rest/v1/rpc/claim_high_impact_alert");
    expect(JSON.parse(String(options.body))).toEqual({
      p_chat_id: 42,
      p_content_hash: hash,
    });
  });

  it("rejects malformed claim inputs before making a request", async () => {
    await expect(supabase.claimHighImpactAlert(42, "not-a-hash")).resolves.toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("records the final alert status with an idempotent upsert", async () => {
    const hash = "b".repeat(64);

    await expect(
      supabase.logHighImpactAlert(42, hash, "success")
    ).resolves.toBe(true);

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/rest/v1/alert_delivery_log?on_conflict=chat_id,content_hash");
    expect(JSON.parse(String(options.body))).toMatchObject({
      chat_id: 42,
      content_hash: hash,
      status: "success",
      claimed_at: null,
    });
  });
});

describe("canonical digest publication boundary", () => {
  it("creates an immutable publication and returns its identity", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => [{ id: 17 }],
    });

    await expect(
      supabase.createDigestPublication("2026-08-19", { schemaVersion: 1 }, new Map([["url", 9]]))
    ).resolves.toBe(17);

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/rest/v1/digest_publications?select=id");
    expect(options.method).toBe("POST");
    expect(JSON.parse(String(options.body))).toEqual({
      publication_date: "2026-08-19",
      schema_version: 1,
      payload: { schemaVersion: 1 },
      article_ids: { url: 9 },
    });
  });

  it("loads only the publication for the requested editorial date", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: 17,
          publication_date: "2026-08-19",
          payload: { schemaVersion: 1 },
          article_ids: { url: 9 },
        },
      ],
    });

    await expect(supabase.getDigestPublication("2026-08-19")).resolves.toMatchObject({
      id: 17,
      publication_date: "2026-08-19",
    });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("publication_date=eq.2026-08-19");
    expect(url).toContain("limit=1");
  });
});


describe("required database reads", () => {
  it("does not confuse a backend failure with an empty audience", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(supabase.getAllActiveUsers()).rejects.toThrow("HTTP 503");
    expect(mockFetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
  it("paginates the complete active audience", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => Array.from({ length: 500 }, (_, chat_id) => ({ chat_id })) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [{ chat_id: 501 }] });
    expect(await supabase.getAllActiveUsers()).toHaveLength(501);
    expect(mockFetch.mock.calls[1][0]).toContain("offset=500");
  });
});
