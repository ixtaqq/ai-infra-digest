type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

function timestamp(): string {
  return new Date().toLocaleString("en-MY", {
    timeZone: "Asia/Kuala_Lumpur",
    hour12: false,
  });
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  const parts = [`[${timestamp()}]`, `[${level}]`, message];
  if (meta) {
    parts.push(JSON.stringify(meta, null, 0));
  }
  console.log(parts.join(" "));
}

export const logger = {
  info: (msg: string, meta?: Record<string, unknown>) => log("INFO", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log("WARN", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log("ERROR", msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => log("DEBUG", msg, meta),
};
