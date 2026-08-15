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
  it("deactivates the user and deletes only chat-owned private rows", async () => {
    await expect(supabase.deleteUserData(42)).resolves.toBe(true);

    expect(mockFetch).toHaveBeenCalledTimes(8);
    const calls = mockFetch.mock.calls as [string, RequestInit][];
    expect(calls[0][0]).toContain("/rest/v1/user_preferences?chat_id=eq.42");
    expect(calls[0][1].method).toBe("PATCH");
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ is_active: false });

    const deletedTables = calls.slice(1).map(([url, options]) => {
      expect(options.method).toBe("DELETE");
      expect(url).toContain("chat_id=eq.42");
      return new URL(url).pathname.split("/").pop();
    });
    expect(deletedTables).toEqual([
      "user_preferences",
      "user_delivery_log",
      "alert_delivery_log",
      "product_events",
      "price_watches",
      "command_usage",
      "article_validations",
    ]);
    expect(calls.some(([url]) => /articles|digest_runs/.test(url))).toBe(false);
  });

  it("continues private-table cleanup and reports false when one boundary fails", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 204 })
      .mockResolvedValueOnce({ ok: true, status: 204 })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue({ ok: true, status: 204 });

    await expect(supabase.deleteUserData(42)).resolves.toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(8);
  });

  it("rejects an unsafe chat id before making a request", async () => {
    await expect(supabase.deleteUserData(Number.NaN)).resolves.toBe(false);
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
