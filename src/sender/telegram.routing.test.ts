import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

/**
 * Registry↔routing seam regression test.
 *
 * The handler tests in index.commands.test.ts mock registerCommand and invoke
 * handlers directly — they never exercise the onText dispatch layer. That blind
 * spot let /sec, /trends, /thesis, /alert, /coverage and /watch ship registered
 * but UNREACHABLE from the live bot (no onText route ever existed for them).
 *
 * This file runs the REAL initCommands() against a fake bot, then simulates
 * incoming messages the way node-telegram-bot-api does (every matching onText
 * callback fires) and asserts each production-registered command name actually
 * reaches its handler.
 */

type OnTextCb = (msg: unknown, match: RegExpExecArray | null) => Promise<void> | void;

const h = vi.hoisted(() => ({
  onTextRegs: [] as { regexp: RegExp; cb: OnTextCb }[],
  sendMessage: vi.fn(async (..._args: unknown[]) => ({ message_id: 1 })),
  emitCommandUsage: vi.fn(),
  logCommandUsage: vi.fn(async () => true),
  getUserPreferences: vi.fn(async () => null as Record<string, unknown> | null),
  upsertUserPreferences: vi.fn(async () => true),
  deleteUserData: vi.fn(async () => true),
  recordProductEvent: vi.fn(async () => true),
  cancelOnboarding: vi.fn(),
}));

vi.mock("node-telegram-bot-api", () => ({
  default: class FakeBot {
    onText(regexp: RegExp, cb: OnTextCb) {
      h.onTextRegs.push({ regexp, cb });
    }
    on() {
      /* callback_query / message listeners — not under test */
    }
    sendMessage(...args: unknown[]) {
      return h.sendMessage(...args);
    }
    async answerCallbackQuery() {}
    processUpdate() {}
  },
}));

vi.mock("../config", () => ({
  config: {
    telegram: { botToken: "test-token", chatId: "1" },
    app: {},
    ai: { provider: "groq", apiKey: "x", model: "m", fastModel: "f", baseUrl: "" },
  },
}));
vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../onboarding", () => ({
  startOnboarding: vi.fn(),
  cancelOnboarding: h.cancelOnboarding,
  handleOnboardingCallback: vi.fn(async () => false),
  handleOnboardingText: vi.fn(),
}));
vi.mock("../utils/metrics", () => ({
  emitCommandUsage: h.emitCommandUsage,
}));
// telegram.ts imports supabase dynamically (settings/watchlist/validation +
// the v13 command-usage log).
vi.mock("../utils/supabase", () => ({
  supabase: {
    isConfigured: () => false,
    getUserPreferences: h.getUserPreferences,
    upsertUserPreferences: h.upsertUserPreferences,
    deleteUserData: h.deleteUserData,
    recordProductEvent: h.recordProductEvent,
    logCommandUsage: h.logCommandUsage,
  },
}));

import { registerCommand, splitMessage, startInteractiveBot } from "./telegram";

// Mirror of every registerCommand() name in src/index.ts's registerDigestCommands().
// If a new command is added there, add it here — this test then proves it routes.
const PRODUCTION_COMMANDS = [
  "digest",
  "sources",
  "last",
  "alert",
  "watch",
  "trending",
  "trends",
  "sources quality",
  "sec",
  "coverage",
  "thesis",
  "feedback",
] as const;

// Sample real-world invocations, including args, per command.
const SAMPLE_INPUTS: Record<(typeof PRODUCTION_COMMANDS)[number], string> = {
  digest: "/digest",
  sources: "/sources",
  last: "/last",
  alert: "/alert on",
  watch: "/watch NVDA 130",
  trending: "/trending",
  trends: "/trends NVDA 30d",
  "sources quality": "/sources quality",
  sec: "/sec NVDA",
  coverage: "/coverage NVDA 14",
  thesis: "/thesis NVDA",
  feedback: "/feedback 5",
};

const spies = new Map<string, ReturnType<typeof vi.fn>>();

/** Fire every onText callback whose regexp matches — same semantics as the real bot. */
async function simulate(text: string) {
  const msg = { chat: { id: 42 }, from: { username: "u", first_name: "F" }, text };
  for (const { regexp, cb } of h.onTextRegs) {
    const match = regexp.exec(text);
    if (match) await cb(msg, match);
  }
}

/**
 * The durable-log leg of logCommandUse() runs via a fire-and-forget
 * `import(...).then(...)` microtask, so it resolves AFTER simulate() returns.
 * Flush the microtask queue before asserting on the durable Supabase call.
 */
const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

beforeAll(() => {
  for (const name of PRODUCTION_COMMANDS) {
    const spy = vi.fn(async () => `${name.toUpperCase()}_REPLY`);
    spies.set(name, spy);
    registerCommand(name, spy);
  }
  // Registers the real onText routes (initCommands) against the FakeBot.
  startInteractiveBot();
});

beforeEach(() => {
  h.sendMessage.mockClear();
  h.emitCommandUsage.mockClear();
  h.logCommandUsage.mockClear();
  h.getUserPreferences.mockClear();
  h.upsertUserPreferences.mockClear();
  h.deleteUserData.mockClear();
  h.recordProductEvent.mockClear();
  h.cancelOnboarding.mockClear();
  for (const spy of spies.values()) spy.mockClear();
});

describe("command routing seam", () => {
  it.each(PRODUCTION_COMMANDS.map((c) => [c] as const))(
    "dispatches %s through a real onText route",
    async (name) => {
      const input = SAMPLE_INPUTS[name];
      await simulate(input);
      expect(spies.get(name)!, `"${input}" never reached its registered handler`).toHaveBeenCalledTimes(1);
      const ctx = spies.get(name)!.mock.calls[0][0] as { chatId: number; text: string };
      expect(ctx.chatId).toBe(42);
      expect(ctx.text).toBe(input);
    }
  );

  it("longest-prefix: /sources quality hits 'sources quality', not 'sources'", async () => {
    await simulate("/sources quality");
    expect(spies.get("sources quality")!).toHaveBeenCalledTimes(1);
    expect(spies.get("sources")!).not.toHaveBeenCalled();
  });

  it("bare /sources still hits 'sources'", async () => {
    await simulate("/sources");
    expect(spies.get("sources")!).toHaveBeenCalledTimes(1);
    expect(spies.get("sources quality")!).not.toHaveBeenCalled();
  });

  it("routes /digest with args (watchlist / sector variants) to the digest handler", async () => {
    await simulate("/digest watchlist");
    expect(spies.get("digest")!).toHaveBeenCalledTimes(1);
    expect((spies.get("digest")!.mock.calls[0][0] as { text: string }).text).toBe("/digest watchlist");
  });

  it("never double-dispatches a bespoke-routed command via the generic dispatcher", async () => {
    await simulate("/digest");
    expect(spies.get("digest")!).toHaveBeenCalledTimes(1);
    await simulate("/feedback 5");
    expect(spies.get("feedback")!).toHaveBeenCalledTimes(1);
  });

  it("strips @botname suffixes before matching", async () => {
    await simulate("/sec@GoldirhamBot NVDA");
    expect(spies.get("sec")!).toHaveBeenCalledTimes(1);
  });

  it("sends the handler reply back to the chat", async () => {
    await simulate("/thesis NVDA");
    const sent = h.sendMessage.mock.calls.map((c) => c[1]);
    expect(sent).toContain("THESIS_REPLY");
  });

  it("replies 'Unknown command' for unregistered commands, without invoking any handler", async () => {
    await simulate("/definitelynotacommand");
    const sent = h.sendMessage.mock.calls.map((c) => String(c[1]));
    expect(sent.some((t) => t.includes("Unknown command"))).toBe(true);
    for (const [name, spy] of spies) {
      expect(spy, `${name} fired for an unknown command`).not.toHaveBeenCalled();
    }
  });

  it("replies with the error message when a handler throws", async () => {
    spies.get("sec")!.mockRejectedValueOnce(new Error("boom"));
    await simulate("/sec NVDA");
    const sent = h.sendMessage.mock.calls.map((c) => String(c[1]));
    expect(sent.some((t) => t.includes("boom"))).toBe(true);
  });
});

describe("command usage logging (v13)", () => {
  it("logs usage (metrics + durable) for a generic-dispatched command", async () => {
    await simulate("/watch NVDA 130");
    expect(h.emitCommandUsage).toHaveBeenCalledWith("watch", 42);
    await flushMicrotasks();
    expect(h.logCommandUsage).toHaveBeenCalledWith("watch", 42);
  });

  it("logs the resolved key for multi-word commands, not the parent", async () => {
    await simulate("/sources quality");
    expect(h.emitCommandUsage).toHaveBeenCalledWith("sources quality", 42);
    expect(h.emitCommandUsage).not.toHaveBeenCalledWith("sources", 42);
  });

  it("logs usage for bespoke-routed commands too (digest / feedback)", async () => {
    await simulate("/digest watchlist");
    expect(h.emitCommandUsage).toHaveBeenCalledWith("digest", 42);
    h.emitCommandUsage.mockClear();
    await simulate("/feedback 5");
    expect(h.emitCommandUsage).toHaveBeenCalledWith("feedback", 42);
  });

  it("does NOT log usage for unknown commands", async () => {
    await simulate("/definitelynotacommand");
    await flushMicrotasks();
    expect(h.emitCommandUsage).not.toHaveBeenCalled();
    expect(h.logCommandUsage).not.toHaveBeenCalled();
  });

  it("still dispatches the command when durable logging rejects (fire-and-forget)", async () => {
    h.logCommandUsage.mockRejectedValueOnce(new Error("supabase down"));
    await simulate("/sec NVDA");
    await flushMicrotasks();
    // The handler must still have run despite the logging failure.
    expect(spies.get("sec")!).toHaveBeenCalledTimes(1);
  });
});

describe("delivery opt-out", () => {
  it.each(["/stop", "/unsubscribe"])("deactivates delivery for %s", async (command) => {
    await simulate(command);

    expect(h.cancelOnboarding).toHaveBeenCalledWith(42);
    expect(h.upsertUserPreferences).toHaveBeenCalledWith({
      chat_id: 42,
      is_active: false,
    });
    expect(h.sendMessage.mock.calls.map((call) => String(call[1]))).toEqual([
      "🛑 <b>Delivery stopped</b>\n\nYou won't receive scheduled digests. Send /resume to continue with your saved preferences, or /start to set up again.",
    ]);
  });

  it("resumes a user who previously completed onboarding", async () => {
    h.getUserPreferences.mockResolvedValueOnce({
      chat_id: 42,
      is_active: false,
      onboarding_completed_at: "2026-08-15T09:00:00.000Z",
    });

    await simulate("/resume");

    expect(h.cancelOnboarding).toHaveBeenCalledWith(42);
    expect(h.upsertUserPreferences).toHaveBeenCalledWith({
      chat_id: 42,
      is_active: true,
    });
    expect(h.recordProductEvent).toHaveBeenCalledWith("delivery_resumed", 42);
    expect(String(h.sendMessage.mock.calls.at(-1)?.[1])).toContain("Delivery resumed");
  });

  it("does not let incomplete onboarding bypass consent through /resume", async () => {
    h.getUserPreferences.mockResolvedValueOnce({ chat_id: 42, is_active: false });

    await simulate("/resume");

    expect(h.upsertUserPreferences).not.toHaveBeenCalled();
    expect(String(h.sendMessage.mock.calls.at(-1)?.[1])).toContain("complete setup");
  });
});

describe("editable settings", () => {
  it.each([
    ["/settings time 07:30", { chat_id: 42, preferred_time: "07:30" }],
    ["/settings timezone America/New_York", { chat_id: 42, timezone: "America/New_York" }],
    ["/settings min_score 7", { chat_id: 42, min_impact_score: 7 }],
    ["/settings length detailed", { chat_id: 42, digest_length: "detailed" }],
    ["/settings categories chips & gpus, Datacenters", { chat_id: 42, categories_enabled: ["Chips & GPUs", "Datacenters"] }],
    ["/settings categories all", { chat_id: 42, categories_enabled: [] }],
  ])("accepts %s", async (input, expected) => {
    await simulate(input);
    expect(h.upsertUserPreferences).toHaveBeenCalledWith(expected);
    expect(String(h.sendMessage.mock.calls.at(-1)?.[1])).toContain("✅");
  });

  it.each([
    "/settings time 7:30",
    "/settings timezone Not/A_Timezone",
    "/settings min_score 11",
    "/settings length verbose",
    "/settings categories Unknown Sector",
  ])("rejects invalid input %s without saving", async (input) => {
    await simulate(input);
    expect(h.upsertUserPreferences).not.toHaveBeenCalled();
    expect(String(h.sendMessage.mock.calls.at(-1)?.[1])).toContain("Settings commands");
  });

  it("keeps bare /settings as a display and escapes stored values", async () => {
    h.getUserPreferences.mockResolvedValueOnce({
      chat_id: 42,
      watchlist: ["<b>NVDA</b>"],
      categories_enabled: ["<i>Injected</i>"],
      preferred_time: "08:00",
      timezone: "UTC",
      min_impact_score: 5,
      digest_length: "standard",
      is_active: true,
    });

    await simulate("/settings");
    const text = String(h.sendMessage.mock.calls.at(-1)?.[1]);
    expect(text).toContain("&lt;b&gt;NVDA&lt;/b&gt;");
    expect(text).toContain("&lt;i&gt;Injected&lt;/i&gt;");
    expect(text).not.toContain("<b>NVDA</b>");
  });
});

describe("private-data deletion", () => {
  it.each(["/delete_my_data", "/delete"])("handles %s", async (command) => {
    await simulate(command);
    expect(h.cancelOnboarding).toHaveBeenCalledWith(42);
    expect(h.deleteUserData).toHaveBeenCalledWith(42);
    expect(String(h.sendMessage.mock.calls.at(-1)?.[1])).toContain("private data was deleted");
  });

  it("reports deletion failures without exposing the database error", async () => {
    h.deleteUserData.mockRejectedValueOnce(new Error("secret database detail"));
    await simulate("/delete_my_data");
    const text = String(h.sendMessage.mock.calls.at(-1)?.[1]);
    expect(text).toContain("couldn't complete");
    expect(text).not.toContain("secret database detail");
  });
});

describe("Telegram message splitting", () => {
  it("hard-splits a line longer than Telegram's limit", () => {
    const chunks = splitMessage("x".repeat(10), 4);

    expect(chunks).toEqual(["xxxx", "xxxx", "xx"]);
    expect(chunks.every((chunk) => chunk.length <= 4)).toBe(true);
  });

  it("keeps an exact-limit line within the limit and does not emit empty chunks", () => {
    const chunks = splitMessage(`${"a".repeat(4)}\ntiny`, 4);

    expect(chunks).toEqual(["aaaa", "tiny"]);
    expect(chunks).not.toContain("");
    expect(chunks.every((chunk) => chunk.length <= 4)).toBe(true);
  });
});
