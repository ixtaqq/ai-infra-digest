import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  constructors: [] as unknown[],
  sendMessage: vi.fn(async () => ({ message_id: 1 })),
}));

vi.mock("node-telegram-bot-api", () => ({
  default: class FakeBot {
    constructor(_token: string, options: unknown) {
      h.constructors.push(options);
    }
    onText() {}
    on() {}
    sendMessage(..._args: unknown[]) {
      return h.sendMessage();
    }
    processUpdate() {}
    async startPolling() {}
    async stopPolling() {}
    async deleteWebHook() {}
    async setWebHook() {}
    async getWebHookInfo() {
      return { url: "", pending_update_count: 0 };
    }
    async answerCallbackQuery() {}
  },
}));

vi.mock("../config", () => ({
  config: {
    telegram: { botToken: "test-token", chatId: "", mode: "send-only" },
    app: {},
    ai: { provider: "groq", apiKey: "", model: "m", fastModel: "f", baseUrl: "" },
  },
}));
vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../utils/metrics", () => ({ emitCommandUsage: vi.fn() }));
vi.mock("../utils/supabase", () => ({
  supabase: {
    isConfigured: () => false,
    logCommandUsage: vi.fn(async () => true),
  },
}));
vi.mock("../processor/ai", () => ({ NEWS_CATEGORIES: ["Chips & GPUs"] }));
vi.mock("../onboarding", () => ({
  startOnboarding: vi.fn(),
  cancelOnboarding: vi.fn(),
  handleOnboardingCallback: vi.fn(async () => false),
  handleOnboardingText: vi.fn(),
}));

beforeEach(() => {
  h.constructors.length = 0;
  h.sendMessage.mockClear();
});

async function loadTelegram() {
  vi.resetModules();
  return import("./telegram");
}

describe("Telegram runtime modes", () => {
  it("creates a send-only client without polling", async () => {
    const telegram = await loadTelegram();

    await telegram.sendDigestMessageToUser(101, "digest");

    expect(h.constructors).toEqual([{ polling: false, request: { timeoutMs: 15_000, maxRetriesOn429: 0 } }]);
    expect(telegram.getTelegramMode()).toBe("send-only");
  });

  it("starts polling only when explicitly requested", async () => {
    const telegram = await loadTelegram();

    telegram.startInteractiveBot({ mode: "polling" });

    expect(h.constructors).toEqual([{ polling: true, request: { timeoutMs: 45_000, maxRetriesOn429: 0 } }]);
    expect(telegram.getTelegramMode()).toBe("polling");
  });

  it("keeps webhook mode non-polling", async () => {
    const telegram = await loadTelegram();

    telegram.enableWebhookMode();
    telegram.startInteractiveBot();

    expect(h.constructors).toEqual([{ polling: false, request: { timeoutMs: 15_000, maxRetriesOn429: 0 } }]);
    expect(telegram.getTelegramMode()).toBe("webhook");
  });
});


it("does not replay a multipart digest after a later part fails", async () => {
  const telegram = await loadTelegram();
  h.sendMessage.mockResolvedValueOnce({ message_id: 1 }).mockRejectedValueOnce(
    Object.assign(new Error("rate limited"), { code: "ETELEGRAM", response: { status: 429 } }));
  const result = await telegram.sendDigestMessageToUser(101, "<b>" + "x".repeat(9000) + "</b>");
  expect(result).toMatchObject({ success: false, ambiguous: true });
  expect(h.sendMessage).toHaveBeenCalledTimes(2);
});
it("distinguishes a confirmed Telegram rejection from an unknown transport result", async () => {
  const telegram = await loadTelegram();
  h.sendMessage.mockRejectedValueOnce(Object.assign(new Error("blocked"), { code: "ETELEGRAM", response: { status: 403 } }));
  expect(await telegram.sendDigestMessageToUser(101, "digest")).toMatchObject({ success: false, ambiguous: false });
  h.sendMessage.mockRejectedValueOnce(new Error("timeout"));
  expect(await telegram.sendDigestMessageToUser(101, "digest")).toMatchObject({ success: false, ambiguous: true });
});
