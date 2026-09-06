import { logger } from "./logger";
import { config } from "../config";
import { supabase } from "./supabase";

/** Read the private attempt ledger. Missing prices or unavailable storage are unknown. */
export async function getRolling30DaySpend(): Promise<number | null> {
  if (!supabase.isConfigured()) return null;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  let total = 0;
  let count = 0;
  try {
    for (let offset = 0; ; offset += 500) {
      const rows = await supabase.requiredRows<{ reported_cost: number | null }>(
        "ai_attempts", `started_at=gte.${encodeURIComponent(since)}&select=reported_cost&order=started_at.asc,id.asc&limit=500&offset=${offset}`);
      for (const row of rows) {
        if (row.reported_cost === null || !Number.isFinite(Number(row.reported_cost))) return null;
        total += Number(row.reported_cost);
        count++;
      }
      if (rows.length < 500) return count ? total : null;
    }
  } catch { return null; }
}

/** Advisory gate over known provider-reported costs; this is not a strict spend cap. */
export async function isMonthlyBudgetExceeded(): Promise<boolean> {
  const spend = await getRolling30DaySpend();
  if (spend === null) {
    logger.warn("AI budget is advisory: complete provider pricing is unavailable");
    return false;
  }
  return spend >= config.app.budgetMonthlyUsd;
}
