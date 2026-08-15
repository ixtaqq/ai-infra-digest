import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fsMocks = vi.hoisted(() => ({
  appendFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
}));

// metrics.ts appends to disk and writes to stdout. Stub both so the test
// asserts the emitted event shape without touching the filesystem.
vi.mock("./logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../config", () => ({ config: { app: {} } }));

vi.mock("fs", () => ({
  existsSync: () => true,
  mkdirSync: vi.fn(),
  promises: fsMocks,
}));

describe("emitCommandUsage", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fsMocks.appendFile.mockClear();
    fsMocks.mkdir.mockClear();
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
      _chunk: string,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ) => {
      const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      done?.();
      return true;
    }) as typeof process.stdout.write);
  });
  afterEach(() => {
    writeSpy.mockRestore();
  });

  it("emits a well-formed command_usage NDJSON event", async () => {
    const { emitCommandUsage, flushMetrics } = await import("./metrics");
    emitCommandUsage("watch", 12345);
    await flushMetrics();

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
    const { emitCommandUsage, flushMetrics } = await import("./metrics");
    emitCommandUsage("sources quality", 7);
    await flushMetrics();
    const event = JSON.parse((writeSpy.mock.calls[0][0] as string).trim());
    expect(event.command).toBe("sources quality");
  });

  it("defers output and flushes events in emission order", async () => {
    const { emitCommandUsage, emitError, flushMetrics } = await import("./metrics");

    emitCommandUsage("first", 1);
    emitError("unknown", "warn", "second");

    expect(writeSpy).not.toHaveBeenCalled();
    expect(fsMocks.appendFile).not.toHaveBeenCalled();

    await flushMetrics();

    const stdoutCalls = writeSpy.mock.calls as unknown[][];
    const fileCalls = fsMocks.appendFile.mock.calls as unknown[][];
    const stdoutEvents = stdoutCalls.map((call) => JSON.parse(String(call[0])).event);
    const fileEvents = fileCalls.map((call) => JSON.parse(String(call[1])).event);
    expect(stdoutEvents).toEqual(["command_usage", "error"]);
    expect(fileEvents).toEqual(["command_usage", "error"]);
  });
});
