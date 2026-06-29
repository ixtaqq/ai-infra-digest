/**
 * Invokes the cleanup_old_data() Supabase RPC (defined in
 * supabase/migrations/20260624120000_v4_indexes_retention.sql) to enforce the
 * 90-day/30-day/365-day retention policy documented in the README.
 *
 * The pg_cron schedule for this function ships commented-out in the migration
 * (pg_cron must be enabled manually in the Supabase dashboard), so this script
 * is the code-controlled alternative: run it on a schedule via GitHub Actions
 * (see .github/workflows/data-retention.yml) without needing DB-admin access.
 *
 * Run:  npx tsx scripts/run-retention-cleanup.ts
 */
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

async function main() {
  if (!url || !key) {
    console.error("❌ SUPABASE_URL / SUPABASE_SERVICE_KEY missing in .env — nothing to clean up.");
    process.exit(1);
  }

  console.log("→ Calling cleanup_old_data() via Supabase RPC...");
  const res = await fetch(`${url}/rest/v1/rpc/cleanup_old_data`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });

  if (!res.ok) {
    console.error(`❌ Retention cleanup failed: HTTP ${res.status} — ${await res.text()}`);
    process.exit(1);
  }

  console.log("✅ Retention cleanup ran successfully (see Supabase logs for row counts via RAISE NOTICE).");
}

main();
