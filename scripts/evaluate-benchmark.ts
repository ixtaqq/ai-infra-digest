import { readFileSync } from "node:fs";
import { benchmarkSchema, compareBenchmark } from "../src/evaluation/benchmark";
import { z } from "zod";

const [reference, predictions] = process.argv.slice(2);
if (!reference || !predictions) throw new Error("Usage: evaluate:benchmark reviewed-cases.json predictions.json (offline; makes no model calls)");
const expected = benchmarkSchema.parse(JSON.parse(readFileSync(reference, "utf8")));
const actual = z.array(z.object({ id: z.string(), relevant: z.boolean(), tickers: z.array(z.string()),
  impact: z.number().min(1).max(10), unsupportedClaims: z.number().int().nonnegative() })).parse(JSON.parse(readFileSync(predictions, "utf8")));
const result = compareBenchmark(expected, actual);
console.log(JSON.stringify(result, null, 2));
if (result.missing || result.relevanceAccuracy < 0.95 || result.tickerAccuracy < 0.95 || result.meanImpactError > 1 || result.unsupportedClaims) process.exitCode = 1;
