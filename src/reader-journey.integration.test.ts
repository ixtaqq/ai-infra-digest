import { expect, it, vi } from "vitest";
import type { Message, CallbackQuery, Update } from "node-telegram-bot-api";
import type { UserPreferencesData } from "./utils/supabase";
import type { GeneratedDigest } from "./pipeline/types";

const h = vi.hoisted(() => ({
  routes: [] as { pattern: RegExp; callback: (message: Message, match: RegExpExecArray) => void }[],
  listeners: new Map<string, ((event: Message | CallbackQuery) => void)[]>(),
  prefs: null as UserPreferencesData | null,
  publication: null as Record<string, unknown> | null,
  slots: new Set<string>(),
  usage: [] as string[],
  sent: [] as string[],
  claim: vi.fn(),
  generate: vi.fn(),
}));
vi.mock("node-telegram-bot-api", () => ({ default: class {
  onText(pattern: RegExp, callback: (message: Message, match: RegExpExecArray) => void) { h.routes.push({ pattern, callback }); }
  on(name: string, callback: (event: Message | CallbackQuery) => void) {
    h.listeners.set(name, [...(h.listeners.get(name) || []), callback]);
  }
  async sendMessage(_chat: number, text: string) { h.sent.push(text); return { message_id: h.sent.length }; }
  async answerCallbackQuery() {}
  async editMessageText() {}
  processUpdate(update: Update) {
    if (update.message) {
      for (const callback of h.listeners.get("message") || []) callback(update.message);
      for (const route of h.routes) {
        const match = route.pattern.exec(update.message.text || "");
        if (match) route.callback(update.message, match);
      }
    }
    if (update.callback_query) for (const callback of h.listeners.get("callback_query") || []) callback(update.callback_query);
  }
} }));
vi.mock("./config", () => ({ config: { telegram: { botToken: "fixture", chatId: "42", mode: "webhook" }, app: { timezone: "UTC" }, ai: {} } }));
vi.mock("./processor/ai", () => ({ NEWS_CATEGORIES: ["Chips & GPUs"], processArticles: h.generate }));
vi.mock("./utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("./utils/metrics", () => ({ emitCommandUsage: vi.fn(), emitDigestDelivery: vi.fn(), emitError: vi.fn() }));
vi.mock("./utils/supabase", () => ({ supabase: {
  isConfigured: () => true,
  getUserPreferences: async () => h.prefs,
  upsertUserPreferences: async (prefs: UserPreferencesData) => { h.prefs = { is_active: false, ...h.prefs, ...prefs }; return true; },
  getLatestDigestPublication: async () => h.publication,
  claimUserDelivery: h.claim,
  logUserDelivery: async () => true,
  recordProductEvent: async () => true,
  logCommandUsage: async (command: string) => { h.usage.push(command); return true; },
  deleteUserData: async () => { h.prefs = null; h.slots.clear(); h.usage.length = 0; return true; },
} }));

import { handleWebhookUpdate, startInteractiveBot } from "./sender/telegram";
import { registerCoreCommands } from "./commands/core";
import { deliverDigest } from "./delivery/deliver";
import { serializeDigestPublication } from "./pipeline/publication";
import { formatDigestTelegram } from "./formatter/telegram";

it("onboards, retrieves, schedules once, retrieves again, stops and deletes through real command routes", async () => {
  const network = vi.fn(() => { throw new Error("External network is forbidden in this fixture"); });
  vi.stubGlobal("fetch", network);
  h.claim.mockImplementation(async (chat: number, date: string) => {
    const key = `${chat}/${date}`;
    if (h.slots.has(key)) return false;
    h.slots.add(key); return true;
  });
  const article = { title: "Fixture capacity expansion", url: "https://example.com/fixture", source: "Fixture", summary: "Capacity grew.",
    category: "Chips & GPUs" as const, impact: "Bullish" as const, impactScore: 8, affectedStocks: ["NVDA"], reason: "A dated filing supports the claim." };
  const generated: GeneratedDigest = {
    publicationId: 7, runDate: "2026-01-01", startTime: Date.now(), formattedMessage: "", articlesCollected: 1,
    feedStatuses: [], secExtracts: [], earningsAnalyses: [], stockPrices: new Map(), activeWatches: [],
    digest: { articles: [article], categories: { "Chips & GPUs": [article] } as GeneratedDigest["digest"]["categories"],
      topStocks: [], summary: "Fixture briefing", marketOutlook: "Mixed", usage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 }, batchesRun: 0 },
    capabilities: Object.fromEntries(["primaryAi", "fallbackAi", "embeddings", "earnings", "supabase", "slack", "email"].map(key => [key, { state: "disabled", detail: "fixture" }])) as GeneratedDigest["capabilities"],
  };
  generated.formattedMessage = formatDigestTelegram(generated.digest, { editionDate: generated.runDate });
  h.publication = { id: 7, publication_date: generated.runDate, payload: serializeDigestPublication(generated) };
  let update = 0;
  const message = (text: string): Message => ({ message_id: ++update, date: 0, chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false, first_name: "Reader" }, text });
  const send = (text: string) => handleWebhookUpdate({ update_id: ++update, message: message(text) });
  const callback = (data: string) => handleWebhookUpdate({ update_id: ++update, callback_query: { id: String(update), chat_instance: "fixture", data,
    from: { id: 42, is_bot: false, first_name: "Reader" }, message: message("") } });
  try {
    registerCoreCommands(); startInteractiveBot("webhook");
    await send("/start");
    expect(h.prefs?.is_active).toBe(false);
    await callback("ob_time_08:00");
    await send("NVDA AMD");
    await callback("ob_score_0");
    await callback("ob_len_standard");
    expect(h.prefs).toMatchObject({ is_active: true, watchlist: ["NVDA", "AMD"], preferred_time: "08:00" });
    await send("/digest");
    expect(h.sent.at(-1)).toContain(article.title);
    expect(h.claim).not.toHaveBeenCalled();
    expect((await deliverDigest(generated, 42, h.prefs!, generated.runDate)).success).toBe(true);
    const sendsAfterDelivery = h.sent.length;
    expect((await deliverDigest(generated, 42, h.prefs!, generated.runDate)).success).toBe(false);
    expect(h.sent).toHaveLength(sendsAfterDelivery);
    await send("/last");
    expect(h.sent.at(-1)).toContain(article.title);
    expect(h.slots.size).toBe(1);
    await send("/stop");
    expect(h.prefs?.is_active).toBe(false);
    await send("/delete_my_data");
    expect(h.prefs).toBeNull(); expect(h.usage).toEqual([]); expect(h.slots.size).toBe(0);
    expect(h.publication).not.toBeNull();
    expect(network).not.toHaveBeenCalled(); expect(h.generate).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
