import { readFileSync } from "node:fs";
import { benchmarkSchema, compareBenchmark, predictionSchema, sourceTextHash } from "../src/evaluation/benchmark";

const [reference, predictions] = process.argv.slice(2);
if (!reference || !predictions) throw new Error("Usage: evaluate:benchmark reviewed-cases.json predictions.json (offline; makes no model calls)");
const expected = benchmarkSchema.parse(JSON.parse(readFileSync(reference, "utf8")));
const actual = predictionSchema.parse(JSON.parse(readFileSync(predictions, "utf8")));
const byId = new Map(expected.map(row => [row.id, row]));
for (const row of actual) {
  const reference = byId.get(row.id);
  if (!reference || row.sourceTextSha256 !== sourceTextHash(reference.sourceText)) {
    throw new Error(`Prediction input does not match the reviewed source for ${row.id}`);
  }
}
const result = compareBenchmark(expected, actual);
console.log(JSON.stringify(result, null, 2));
if (result.missing || result.relevanceAccuracy < 0.95 || result.tickerAccuracy < 0.95 || result.meanImpactError > 1 || result.unsupportedClaims) process.exitCode = 1;
