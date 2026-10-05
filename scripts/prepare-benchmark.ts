import { writeFileSync } from "node:fs";
import Parser from "rss-parser";
import { sourceTextHash } from "../src/evaluation/benchmark";
import { reviewSetSchema } from "../src/evaluation/review-set";

const feeds = [
  ["NVIDIA", "https://blogs.nvidia.com/feed/"],
  ["AWS", "https://aws.amazon.com/blogs/aws/feed/"],
  ["Cloudflare", "https://blog.cloudflare.com/rss/"],
  ["Google", "https://blog.google/rss/"],
  ["NASA", "https://www.nasa.gov/feed/"],
] as const;

async function main() {
  const [output] = process.argv.slice(2);
  if (!output) throw new Error("Usage: prepare:benchmark new-review-set.json (public RSS only; no model calls)");
  const capturedAt = new Date().toISOString();
  const batches = await Promise.all(feeds.map(async ([sourceName, sourceFeedUrl]) => {
    const response = await fetch(sourceFeedUrl, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`${sourceName}: HTTP ${response.status}`);
    const feed = await new Parser().parseString(await response.text());
    const seen = new Set<string>();
    return feed.items.flatMap(item => {
      if (!item.link || seen.has(item.link) || !/^https:\/\//.test(item.link)) return [];
      seen.add(item.link);
      const text = `${item.title || ""}. ${item.contentSnippet || item.summary || ""}`.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      const sourceText = text.split(/\s+/).slice(0, 25).join(" ");
      if (sourceText.length < 40) return [];
      return [{
        id: sourceTextHash(item.link).slice(0, 16), sourceUrl: item.link, sourceText,
        sourceTextSha256: sourceTextHash(sourceText), sourceName, sourceFeedUrl, capturedAt,
        publishedAt: item.isoDate && Number.isFinite(Date.parse(item.isoDate)) ? new Date(item.isoDate).toISOString() : null,
        inputKind: "rss-excerpt", review: null,
      }];
    }).slice(0, 10);
  }));
  const rows = reviewSetSchema.parse(batches.flat());
  writeFileSync(output, JSON.stringify(rows, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ output, cases: rows.length, pending: rows.length, sources: feeds.map(([name]) => name) }, null, 2));
}

main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
