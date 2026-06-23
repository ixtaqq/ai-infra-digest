import { describe, it, expect, vi } from "vitest";

// Extend the module type so TypeScript knows about our named mock export
interface MockBotMethods {
  sendMessage: ReturnType<typeof vi.fn>;
  onText: ReturnType<typeof vi.fn>;
  deleteWebHook: ReturnType<typeof vi.fn>;
  setWebHook: ReturnType<typeof vi.fn>;
  getWebHookInfo: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

declare module "node-telegram-bot-api" {
  export const mockMethods: MockBotMethods;
}

// ─── Mock Config ──────────────────────────────────────
vi.mock("../config", () => ({
  config: {
    telegram: { botToken: "mock-bot-token", chatId: "12345" },
    app: {
      cacheDir: "/tmp/test-cache",
      timezone: "Asia/Kuala_Lumpur",
      maxArticlesPerSource: 5,
    },
    ai: { provider: "groq", apiKey: "test", model: "test", baseUrl: "https://test.com" },
  },
}));

// ─── Mock node-telegram-bot-api with named exports ───
vi.mock("node-telegram-bot-api", () => {
  const mockMethods = {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
    onText: vi.fn(),
    deleteWebHook: vi.fn().mockResolvedValue(true),
    setWebHook: vi.fn().mockResolvedValue(true),
    getWebHookInfo: vi.fn().mockResolvedValue({
      url: "",
      pending_update_count: 0,
      last_error_message: null,
    }),
    on: vi.fn(),
  };

  // Return a constructor that works with `new`
  const MockBot = function () {
    return mockMethods;
  };
  MockBot.prototype.constructor = MockBot;

  return { default: MockBot, mockMethods };
});

describe("Telegram Integration", () => {
  it("should send a message and return success with messageId", async () => {
    const { sendTelegramMessage } = await import("../sender/telegram");
    const result = await sendTelegramMessage("<b>Test</b>", "HTML");

    expect(result.success).toBe(true);
    expect(result.messageId).toBe(42);
  });

  it("should handle send errors gracefully", async () => {
    const { mockMethods } = await import("node-telegram-bot-api");
    mockMethods.sendMessage.mockRejectedValueOnce(new Error("chat not found"));

    const { sendTelegramMessage } = await import("../sender/telegram");
    const result = await sendTelegramMessage("Test", "HTML");

    expect(result.success).toBe(false);
    expect(result.error).toContain("chat not found");
  });

  it("should detect 'bot was blocked' error", async () => {
    const { mockMethods } = await import("node-telegram-bot-api");
    mockMethods.sendMessage.mockRejectedValueOnce(
      new Error("bot was blocked by the user")
    );

    const { sendTelegramMessage } = await import("../sender/telegram");
    const result = await sendTelegramMessage("Test", "HTML");

    expect(result.success).toBe(false);
    expect(result.error).toContain("bot was blocked");
  });

  it("should send short messages in one part", async () => {
    const { mockMethods } = await import("node-telegram-bot-api");
    // Clear accumulated calls from previous tests (bot is cached module-globally)
    mockMethods.sendMessage.mockClear();
    const { sendDigestMessage } = await import("../sender/telegram");
    await sendDigestMessage("Short message");

    expect(mockMethods.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("should split long messages into chunks", async () => {
    const { mockMethods } = await import("node-telegram-bot-api");
    const { sendDigestMessage } = await import("../sender/telegram");
    const longMsg = "A".repeat(10000);
    await sendDigestMessage(longMsg);

    expect(mockMethods.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("should register command handlers", async () => {
    const { registerCommand, startInteractiveBot } = await import(
      "../sender/telegram"
    );
    expect(typeof registerCommand).toBe("function");
    expect(typeof startInteractiveBot).toBe("function");

    const handler = async () => "Handled!";
    expect(() => registerCommand("testcmd", handler)).not.toThrow();
  });

  it("should set webhook and verify it", async () => {
    const { mockMethods } = await import("node-telegram-bot-api");
    mockMethods.getWebHookInfo.mockResolvedValueOnce({
      url: "https://example.com/webhook",
      pending_update_count: 0,
      last_error_message: null,
    });

    const { setupWebhook } = await import("../sender/telegram");
    const result = await setupWebhook("https://example.com/webhook");

    expect(result).toBe(true);
    expect(mockMethods.setWebHook).toHaveBeenCalledWith(
      "https://example.com/webhook",
      expect.objectContaining({ max_connections: 40 })
    );
  });

  it("should return webhook info", async () => {
    const { mockMethods } = await import("node-telegram-bot-api");
    mockMethods.getWebHookInfo.mockResolvedValueOnce({
      url: "https://example.com/webhook",
      pending_update_count: 5,
      last_error_message: "bad request",
    });

    const { getWebhookInfo } = await import("../sender/telegram");
    const info = await getWebhookInfo();

    expect(info.url).toBe("https://example.com/webhook");
    expect(info.pendingUpdates).toBe(5);
    expect(info.lastError).toBe("bad request");
  });

  it("should switch to polling by deleting webhook", async () => {
    const { mockMethods } = await import("node-telegram-bot-api");
    const { switchToPolling } = await import("../sender/telegram");
    await switchToPolling();

    expect(mockMethods.deleteWebHook).toHaveBeenCalled();
  });
});
