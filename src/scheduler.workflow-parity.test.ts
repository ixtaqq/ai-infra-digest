import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(__dirname, "..");
const workflowPath = resolve(repoRoot, ".github", "workflows", "scheduled-delivery.yml");

describe("scheduled-delivery workflow/runtime parity", () => {
  it("runs the compiled scheduler without AI/default-chat credentials or polling", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toContain("run: node dist/scheduler.js");
    expect(workflow).toMatch(/TELEGRAM_BOT_TOKEN:\s*\$\{\{ secrets\.TELEGRAM_BOT_TOKEN \}\}/);
    expect(workflow).toMatch(/SUPABASE_URL:\s*\$\{\{ secrets\.SUPABASE_URL \}\}/);
    expect(workflow).not.toMatch(/^\s+AI_API_KEY:/m);
    expect(workflow).not.toMatch(/^\s+TELEGRAM_CHAT_ID:/m);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_CHAT_ID: "",
      AI_API_KEY: "",
      SUPABASE_URL: "",
      SUPABASE_SERVICE_KEY: "",
    };
    delete env.CONFIG_SCOPE;
    delete env.RUNTIME_SCOPE;
    delete env.TELEGRAM_MODE;
    delete env.TELEGRAM_BOT_MODE;

    const result = spawnSync(
      process.execPath,
      [resolve(repoRoot, "dist", "scheduler.js")],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 30_000,
        env,
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("scheduled delivery requires a database");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("getUpdates");
  });
});
