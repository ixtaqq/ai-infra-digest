import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandHandler } from "../sender/telegram";

const h = vi.hoisted(() => ({ handlers: new Map<string, CommandHandler>(), latest: vi.fn(), prefs: vi.fn(), event: vi.fn() }));
vi.mock("../sender/telegram", () => ({ registerCommand: (key: string, handler: CommandHandler) => h.handlers.set(key, handler) }));
vi.mock("../utils/supabase", () => ({ supabase: { isConfigured: () => true,
  getLatestDigestPublication: h.latest, getUserPreferences: h.prefs, recordProductEvent: h.event } }));
import { registerCoreCommands } from "./core";

function edition() {
  const article = { title: "Evidence from a filing", url: "https://example.com/filing", source: "SEC", summary: "Capacity expanded.",
    impact: "Bullish", impactScore: 8, affectedStocks: ["NVDA"], reason: "Company reported increased capacity", category: "Chips & GPUs" };
  return { schemaVersion: 1, promptVersion: "fixture", analysisSchemaVersion: 1, runDate: "2026-01-01", formattedMessage: "original",
    digest: { articles: [article], topStocks: [], marketOutlook: "Mixed", summary: "Capacity", categories: { "Chips & GPUs": [article] },
      usage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 }, batchesRun: 0 },
    articlesCollected: 1, feedStatuses: [], secExtracts: [], earningsAnalyses: [], stockPrices: [],
    capabilities: Object.fromEntries(["primaryAi","fallbackAi","embeddings","earnings","supabase","slack","email"].map(key => [key,{state:"disabled",detail:"fixture"}]))
  };
}
beforeEach(() => { registerCoreCommands(); h.prefs.mockReset().mockResolvedValue({ chat_id: 1 });
  h.latest.mockReset().mockResolvedValue({ id: 2, payload: edition() }); h.event.mockReset().mockResolvedValue(true); });

describe("published briefing retrieval", () => {
  it.each(["digest", "last"])("/%s returns the edition with its original date", async command => {
    const result = await h.handlers.get(command)!({ chatId: 1, text: `/${command}` });
    expect(result).toContain("Evidence from a filing"); expect(result).toContain("2026-01-01");
    expect(result).toContain("Latest available edition"); expect(result).not.toContain("npm run");
  });
  it("prompts for an empty watchlist", async () => {
    expect(await h.handlers.get("digest")!({ chatId: 1, text: "/digest watchlist" })).toContain("watchlist is empty");
    expect(h.latest).not.toHaveBeenCalled();
  });
  it("reports filters with no matches", async () => {
    h.prefs.mockResolvedValue({ chat_id: 1, watchlist: ["AMD"] });
    expect(await h.handlers.get("digest")!({ chatId: 1, text: "/digest watchlist" })).toContain("No articles");
  });
  it("reports an unpublished briefing", async () => {
    h.latest.mockResolvedValue(null);
    expect(await h.handlers.get("last")!({ chatId: 1, text: "/last" })).toContain("not been published");
  });
  it("rejects invalid stored editions", async () => {
    h.latest.mockResolvedValue({ id: 2, payload: {} });
    await expect(h.handlers.get("digest")!({ chatId: 1, text: "/digest" })).rejects.toThrow("Invalid digest publication");
  });
});
