import { readFileSync, writeFileSync } from "node:fs";
import { compileReviewedCases, reviewSetSchema } from "../src/evaluation/review-set";

function main() {
  const [action, input, output] = process.argv.slice(2);
  if (!["status", "export"].includes(action) || !input || (action === "export" && !output)) {
    throw new Error("Usage: review:benchmark status review-set.json | export review-set.json new-reviewed-cases.json");
  }
  const rows = reviewSetSchema.parse(JSON.parse(readFileSync(input, "utf8")));
  const reviewed = rows.filter(row => row.review !== null).length;
  if (action === "status") {
    console.log(JSON.stringify({ cases: rows.length, reviewed, pending: rows.length - reviewed,
      readyForEvaluation: reviewed === rows.length, sources: [...new Set(rows.map(row => row.sourceName))] }, null, 2));
    return;
  }
  const reference = compileReviewedCases(rows);
  writeFileSync(output!, JSON.stringify(reference, null, 2) + "\n", { flag: "wx" });
  console.log(`Exported ${reference.length} reviewed cases to ${output}`);
}

try { main(); } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
