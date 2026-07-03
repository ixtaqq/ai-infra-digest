/**
 * Weekly Bull/Bear Thesis Snapshot generator (v10).
 *
 * Aggregates the last 30 days of daily_derived_metrics for the top 10
 * most-mentioned tickers, generates a bull/bear thesis per ticker with the
 * strong model (one batched call, ~$0.01), and upserts into ticker_theses.
 *
 * Scheduled by .github/workflows/weekly-thesis.yml (Sundays); also runnable
 * manually:  npx tsx scripts/run-weekly-thesis.ts
 */
import { generateTheses } from "../src/processor/thesis";

async function main() {
  const theses = await generateTheses();
  if (!theses.length) {
    console.log("No theses generated (no history yet, or AI returned nothing usable).");
    return;
  }
  console.log(`\nGenerated ${theses.length} thesis snapshot(s):\n`);
  for (const t of theses) {
    console.log(`── ${t.ticker} (confidence ${t.confidence}/10) ──`);
    console.log(`  🟢 ${t.bull_case}`);
    console.log(`  🔴 ${t.bear_case}`);
    if (t.key_drivers.length) console.log(`  🔑 ${t.key_drivers.join(" · ")}`);
    console.log("");
  }
}

main().catch((err) => {
  console.error("Thesis generation failed:", (err as Error).message);
  process.exit(1);
});
