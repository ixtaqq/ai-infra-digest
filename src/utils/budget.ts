import { config } from "../config";
import { supabase } from "./supabase";

/**
 * Sum estimated_cost across daily_metrics for the trailing 30 days.
 * Returns 0 (fail-open) if Supabase isn't configured or the query fails —
 * a Supabase hiccup should never be able to silently block every future run.
 */
export async function getRolling30DaySpend(): Promise<number> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString().split("T")[0];
  const rows = await supabase.queryRows<{ estimated_cost: number }>(
    "daily_metrics",
    `date=gte.${encodeURIComponent(thirtyDaysAgo)}&select=estimated_cost`
  );
  return rows.reduce((s, r) => s + (r.estimated_cost || 0), 0);
}

/**
 * Pre-spend gate, checked before any AI call is made for the run.
 * Unlike the post-spend alert in checkBudget(), this can actually prevent
 * the run from incurring AI cost once the rolling 30-day cap is reached.
 */
export async function isMonthlyBudgetExceeded(): Promise<boolean> {
  const spend = await getRolling30DaySpend();
  return spend >= config.app.budgetMonthlyUsd;
}
