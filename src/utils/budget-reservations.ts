import { config } from "../config";
import { supabase } from "./supabase";

export async function reserveAttempt(id: string, input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<boolean> {
  const mode = process.env.AI_BUDGET_MODE || "advisory";
  if (mode === "advisory") return false;
  if (mode !== "enforced") throw new Error("AI_BUDGET_MODE must be advisory or enforced");
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const body = JSON.parse(String(init?.body));
  if (body.stream || typeof body.model !== "string") throw new Error("Enforced budgets require a known model and non-streaming usage");
  const outputLimit = url.pathname.endsWith("/embeddings") ? 0 : Number(body.max_completion_tokens ?? body.max_tokens);
  if (!Number.isSafeInteger(outputLimit) || outputLimit < 0) throw new Error("Enforced budgets require an output-token limit");
  const approved = await supabase.requiredRpc<boolean>("reserve_ai_attempt", {
    p_id: id, p_endpoint: url.origin, p_model: body.model, p_output_limit: outputLimit,
    p_daily_cap: config.app.budgetDailyUsd, p_monthly_cap: config.app.budgetMonthlyUsd,
  });
  if (!approved) throw new Error("AI call blocked: budget unavailable, exhausted, or model pricing has not been reviewed");
  return true;
}

export async function settleAttempt(id: string, cost: number | null, prompt: number | null, completion: number | null): Promise<void> {
  await supabase.requiredRpc("settle_ai_attempt", { p_id: id, p_cost: cost, p_prompt: prompt, p_completion: completion });
}
