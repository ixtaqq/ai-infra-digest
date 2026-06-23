/**
 * Quick test to verify Groq API works with native fetch
 * Run: npx tsx scripts/test-groq.ts
 */
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
  timeout: 120000,
  maxRetries: 1,
  fetch: globalThis.fetch,
});

async function main() {
  console.log("Test 1: Simple request...");
  const r1 = await client.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: "Say hi" }],
  });
  console.log("  OK:", r1.choices[0]?.message?.content);

  console.log("Test 2: JSON mode...");
  const r2 = await client.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: "You are an equity research AI." },
      { role: "user", content: "Analyze: NVIDIA launched Blackwell. Return JSON with title, impact, score, stocks." },
    ],
    temperature: 0.3,
    max_tokens: 512,
    response_format: { type: "json_object" as const },
  });
  console.log("  OK:", r2.choices[0]?.message?.content);

  console.log("Test 3: Medium batch (5 articles)...");
  const articles = [
    "NVIDIA launches Blackwell Ultra GPU for AI workloads",
    "Microsoft announces $10B AI datacenter expansion",
    "AMD reports Q2 earnings beating estimates",
    "Broadcom receives analyst upgrade to Strong Buy",
    "TSMC confirms 3nm chip production for AI accelerators",
  ];
  const prompt = `Analyze these articles and return JSON with array of {title, impact, score, stocks}:\n${articles.map((a, i) => `[${i + 1}] ${a}`).join("\n")}`;
  const r3 = await client.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: "Respond with valid JSON only." },
      { role: "user", content: prompt },
    ],
    temperature: 0.3,
    max_tokens: 2048,
    response_format: { type: "json_object" as const },
  });
  console.log("  OK:", r3.choices[0]?.message?.content?.slice(0, 150) + "...");

  console.log("\n✅ All Groq tests passed!");
}

main().catch((e) => {
  console.error("❌ FAILED:", e.message);
  process.exit(1);
});
