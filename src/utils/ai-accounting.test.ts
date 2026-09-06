import { afterEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ record: vi.fn().mockResolvedValue(true) }));
vi.mock("./supabase", () => ({ supabase: { isConfigured: () => true, recordAIAttempt: h.record } }));
vi.mock("./logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
import { accountedFetch } from "./ai-accounting";
afterEach(() => { vi.unstubAllGlobals(); h.record.mockClear(); });
describe("AI attempt accounting", () => {
  it.each(["ai", "ai-fallback", "sec", "earnings", "bear-cases", "thesis", "embeddings", "relevance"])("records %s without retaining prompts", async stage => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ usage: { total_tokens: 15, prompt_tokens: 10, completion_tokens: 5 } }))));
    const response = await accountedFetch(stage, "provider")("https://example.com", { body: JSON.stringify({ model: "model", messages: ["private source"] }) });
    expect(await response.json()).toHaveProperty("usage.total_tokens", 15);
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ stage, model: "model", total_tokens: 15, reported_cost: null }));
    expect(JSON.stringify(h.record.mock.calls)).not.toContain("private source");
  });
  it("records explicit unknown usage on a failed network attempt", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    await expect(accountedFetch("ai", "provider")("https://example.com")).rejects.toThrow("timeout");
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", total_tokens: null, reported_cost: null }));
  });
  it("does not turn successful AI work into a retry when ledger storage fails", async () => {
    h.record.mockResolvedValueOnce(false);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
    expect((await accountedFetch("ai", "provider")("https://example.com")).ok).toBe(true);
  });
});
