import { afterEach, expect, it, vi } from "vitest";
const rpc = vi.hoisted(() => vi.fn());
vi.mock("./supabase", () => ({ supabase: { requiredRpc: rpc } }));
import { reserveAttempt, settleAttempt } from "./budget-reservations";
afterEach(() => { vi.unstubAllEnvs(); rpc.mockReset(); });
it("does not reserve in advisory mode", async () => {
  vi.stubEnv("AI_BUDGET_MODE", "advisory");
  expect(await reserveAttempt("id", "https://example.com")).toBe(false);
  expect(rpc).not.toHaveBeenCalled();
});
it("blocks unknown prices or unavailable budget before transport", async () => {
  vi.stubEnv("AI_BUDGET_MODE", "enforced"); rpc.mockResolvedValue(false);
  await expect(reserveAttempt("id", "https://example.com/chat/completions", { body: JSON.stringify({ model: "unknown", max_tokens: 100 }) })).rejects.toThrow("blocked");
});
it("refuses unbounded completion requests", async () => {
  vi.stubEnv("AI_BUDGET_MODE", "enforced");
  await expect(reserveAttempt("id", "https://example.com/chat/completions", { body: JSON.stringify({ model: "model" }) })).rejects.toThrow("output-token limit");
  expect(rpc).not.toHaveBeenCalled();
});
it("retains unknown cost in settlement", async () => {
  rpc.mockResolvedValue(true); await settleAttempt("id", null, null, null);
  expect(rpc).toHaveBeenCalledWith("settle_ai_attempt", { p_id: "id", p_cost: null, p_prompt: null, p_completion: null });
});
