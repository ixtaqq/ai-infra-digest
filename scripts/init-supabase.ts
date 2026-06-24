/**
 * Supabase connection test & schema setup guide
 * Run: npx tsx scripts/init-supabase.ts
 */
import { config } from "../src/config";

async function main() {
  const url = config.app.supabaseUrl;
  const key = config.app.supabaseServiceKey;

  if (!url || !key) {
    console.error("❌ SUPABASE_URL or SUPABASE_SERVICE_KEY not set in .env");
    process.exit(1);
  }

  console.log("🔌 Testing Supabase connection...");
  console.log(`   URL: ${url}`);

  // Test connection by fetching from digest_runs
  try {
    const response = await fetch(`${url}/rest/v1/digest_runs?limit=1`, {
      headers: {
        "apikey": key,
        "Authorization": `Bearer ${key}`,
      },
    });

    if (response.ok) {
      const data = await response.json();
      console.log("✅ Connection OK! Table `digest_runs` exists.");
      console.log(`   Records: ${data.length}`);
      console.log("\n🚀 Dashboard is ready. Run the digest to populate data:");
      console.log("   npm run test-digest");
    } else if (response.status === 404) {
      console.log("⚠️  Connection works but tables don't exist yet.");
      console.log("\n📋 You need to run the SQL schema first:");
      console.log("   1. Go to: https://supabase.com/dashboard/project/hxldibicsyydkannudha");
      console.log("   2. Click 'SQL Editor' in the left sidebar");
      console.log("   3. Paste the contents of supabase-schema.sql");
      console.log("   4. Click 'Run'");
      console.log("\n   Or run this SQL directly:");
      console.log("   npx tsx scripts/init-supabase.ts --run-sql");
    } else {
      const text = await response.text();
      console.log(`❌ Error ${response.status}: ${text.slice(0, 200)}`);
    }
  } catch (error) {
    console.error("❌ Connection failed:", (error as Error).message);
    console.log("\n   Make sure SUPABASE_URL is valid and accessible.");
  }
}

main().catch(console.error);
