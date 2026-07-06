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
  handleOnboardingCallback: vi.fn(async () => false),
  handleOnboardingText: vi.fn(),
}));
// telegram.ts imports supabase dynamically (settings/watchlist/validation paths)
vi.mock("../utils/supabase", () => ({
  supabase: {
    isConfigured: () => false,
    getUserPreferences: vi.fn(async () => null),
    upsertUserPreferences: vi.fn(async () => true),
  },
}));

import { registerCommand, startInteractiveBot } from "./telegram";

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
