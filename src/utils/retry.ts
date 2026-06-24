import { logger } from "./logger";

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Return false to stop retrying immediately (e.g. auth errors) */
  shouldRetry?: (error: Error, attempt: number) => boolean;
  label?: string;
}

/**
 * Run `fn` with exponential backoff + full-jitter retry.
 * Non-retryable errors (shouldRetry returns false) re-throw immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30_000,
    shouldRetry = () => true,
    label = "operation",
  } = opts;

  let lastError: Error = new Error("unknown");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;

      if (attempt === maxAttempts || !shouldRetry(lastError, attempt)) {
        throw lastError;
      }

      // Full-jitter backoff: random in [0, min(baseDelay * 2^attempt, maxDelay)]
      const cap = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
      const delay = Math.random() * cap;

      logger.warn(
        `${label} failed (attempt ${attempt}/${maxAttempts}): ${lastError.message} — retrying in ${Math.round(delay)}ms`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}

/**
 * Run `fn` and return `{ ok: true, value }` or `{ ok: false, error }`.
 * Never throws — use for optional pipeline stages.
 */
export async function tryStage<T>(
  fn: () => Promise<T>,
  label: string
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    const msg = (err as Error).message;
    logger.warn(`Stage "${label}" failed: ${msg}`);
    return { ok: false, error: msg };
  }
}
