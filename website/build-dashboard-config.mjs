import fs from "node:fs";
import path from "node:path";

const url = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
const key = (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "").trim();
const outputPath = path.join(process.cwd(), "dashboard", "config.js");

function isSafeSupabaseUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isSafeClientKey(value) {
  if (/^sb_publishable_[A-Za-z0-9_]+$/.test(value)) return true;
  try {
    const part = value.split(".")[1];
    if (!part) return false;
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return payload.role === "anon";
  } catch {
    return false;
  }
}

if (!isSafeSupabaseUrl(url)) {
  throw new Error("SUPABASE_URL must be a configured HTTPS URL");
}
if (!isSafeClientKey(key)) {
  throw new Error("SUPABASE_PUBLISHABLE_KEY/SUPABASE_ANON_KEY must be a public client key");
}

fs.writeFileSync(
  outputPath,
  `window.GOLDIRHAM_SUPABASE_CONFIG=${JSON.stringify({ url, key })};\n`,
  "utf8"
);

console.log(
  "Dashboard config generated: URL configured, public client key configured"
);
