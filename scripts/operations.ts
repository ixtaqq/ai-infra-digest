import "../src/config";
import { supabase } from "../src/utils/supabase";

async function main() {
  const [action = "status", target, rawId, status, ...reasonParts] = process.argv.slice(2);
  if (action === "activation") {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const counts: Record<string, number> = {};
    const users = new Map<string, Set<number>>();
    const readingDays = new Map<number, Set<string>>();
    for (let offset = 0; ; offset += 500) {
      const rows = await supabase.requiredRows<{ event_name: string; chat_id: number; created_at: string }>("product_events",
        `created_at=gte.${encodeURIComponent(since)}&select=event_name,chat_id,created_at&order=id.asc&limit=500&offset=${offset}`);
      for (const row of rows) {
        counts[row.event_name] = (counts[row.event_name] || 0) + 1;
        if (!users.has(row.event_name)) users.set(row.event_name, new Set());
        users.get(row.event_name)!.add(row.chat_id);
        if (row.event_name === "briefing_retrieved") {
          if (!readingDays.has(row.chat_id)) readingDays.set(row.chat_id, new Set());
          readingDays.get(row.chat_id)!.add(row.created_at.slice(0, 10));
        }
      }
      if (rows.length < 500) break;
    }
    console.log(JSON.stringify({ since, counts, distinctUsers: Object.fromEntries([...users].map(([name, ids]) => [name, ids.size])),
      readersRequestingOnMultipleUtcDays: [...readingDays.values()].filter(days => days.size > 1).length }, null, 2));
    return;
  }
  if (action === "resolve") {
    const reason = reasonParts.join(" ");
    const id = Number(rawId);
    if (!["digest", "alert"].includes(target) || !Number.isSafeInteger(id) || id <= 0 || !["success","failed"].includes(status) || reason.trim().length < 20) {
      throw new Error("Usage: operations resolve digest|alert ID success|failed evidence-and-reason-at-least-20-characters");
    }
    const changed = await supabase.requiredRpc("reconcile_delivery", { p_target: target, p_id: id, p_status: status, p_reason: reason });
    if (!changed) throw new Error("Record was not unresolved; no change made");
    console.log("Resolution recorded with an audit trail.");
    return;
  }
  if (action !== "status") throw new Error("Use operations status, activation, or resolve");
  const [edition, digests, alerts, inbox, jobs] = await Promise.all([
    supabase.getLatestDigestPublication(),
    supabase.requiredRows("user_delivery_log", "status=in.(pending,ambiguous)&select=id,run_date,status,publication_id,claimed_at&order=id.asc&limit=100"),
    supabase.requiredRows("alert_delivery_log", "status=in.(pending,ambiguous)&select=id,status,claimed_at&order=id.asc&limit=100"),
    supabase.requiredRows("telegram_inbox", "status=in.(pending,processing,ambiguous)&select=update_id,status,accepted_at&order=accepted_at.asc&limit=100"),
    supabase.requiredRows("editorial_jobs", "status=eq.running&select=editorial_date,status,started_at&order=editorial_date.asc&limit=100"),
  ]);
  console.log(JSON.stringify({ edition: edition?.publication_date ?? null, unresolvedDigests: digests, unresolvedAlerts: alerts, inbox, jobs, limitPerList: 100 }, null, 2));
  if (!edition?.published_at || Date.now() - Date.parse(edition.published_at) > 36 * 3600000 || digests.length || alerts.length || inbox.length || jobs.length) process.exitCode = 1;
}
main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
