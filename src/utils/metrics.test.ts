import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// metrics.ts appends to disk and writes to stdout. Stub both so the test
// asserts the emitted event shape without touching the filesystem.
vi.mock("./logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../config", () => ({ config: { app: {} } }));

vi.mock("fs", () => ({
  existsSync: () => true,
  mkdirSync: vi.fn(),
  promises: { appendFile: vi.fn(async () => undefined) },
}));

describe("emitCommandUsage", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    writeSpy.mockRestore();
  });

  it("emits a well-formed command_usage NDJSON event", async () => {
    const { emitCommandUsage } = await import("./metrics");
    emitCommandUsage("watch", 12345);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const line = writeSpy.mock.calls[0][0] as string;
    expect(line.endsWith("\n")).toBe(true);

    const event = JSON.parse(line.trim());
    expect(event.event).toBe("command_usage");
    expect(event.command).toBe("watch");
    expect(event.chat_id).toBe(12345);
    expect(typeof event.timestamp).toBe("string");
    // ISO-8601 timestamp
    expect(Number.isNaN(Date.parse(event.timestamp))).toBe(false);
  });

  it("preserves multi-word command keys verbatim", async () => {
    const { emitCommandUsage } = await import("./metrics");
    emitCommandUsage("sources quality", 7);
    const event = JSON.parse((writeSpy.mock.calls[0][0] as string).trim());
    expect(event.command).toBe("sources quality");
  });
});
