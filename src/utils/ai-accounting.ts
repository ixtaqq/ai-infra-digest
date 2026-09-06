import { randomUUID } from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import { logger } from "./logger";
import { supabase } from "./supabase";

export interface AIAttempt {
  id: string;
  started_at: string;
  stage: string;
  provider: string;
  model: string;
  status: "success" | "failed";
  duration_ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  reported_cost: number | null;
}
const attempts: AIAttempt[] = [];
const accountingScope = new AsyncLocalStorage<AIAttempt[]>();
export function withAIAccounting<T>(work: () => Promise<T>): Promise<T> {
  return accountingScope.run([], work);
}
const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** Instrument the transport so SDK retries and direct HTTP calls are all counted. */
export function accountedFetch(stage: string, provider: string): typeof fetch {
  return async (input, init) => {
    const started = Date.now();
    let model = "unknown";
    try { model = JSON.parse(String(init?.body)).model || model; } catch { /* No prompt logging. */ }
    const attempt: AIAttempt = {
      id: randomUUID(), started_at: new Date(started).toISOString(), stage, provider, model,
      status: "failed", duration_ms: 0, prompt_tokens: null, completion_tokens: null,
      total_tokens: null, reported_cost: null,
    };
    try {
      const timeout = AbortSignal.timeout(180_000);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      const response = await globalThis.fetch(input, { ...init, signal });
      attempt.status = response.ok ? "success" : "failed";
      try {
        const data = await response.clone().json() as { usage?: Record<string, unknown> };
        const usage = data.usage;
        attempt.prompt_tokens = finite(usage?.prompt_tokens);
        attempt.completion_tokens = finite(usage?.completion_tokens);
        attempt.total_tokens = finite(usage?.total_tokens);
        attempt.reported_cost = finite(usage?.cost);
      } catch { /* Missing or unreadable usage is explicitly unknown. */ }
      return response;
    } finally {
      attempt.duration_ms = Date.now() - started;
      attempts.push(attempt);
      accountingScope.getStore()?.push(attempt);
      // Keep long-lived webhook processes bounded; the durable ledger is authoritative.
      if (attempts.length > 10_000) attempts.splice(0, attempts.length - 10_000);
      logger.info(`AI attempt ${JSON.stringify(attempt)}`);
      try {
        if (supabase.isConfigured()) {
          if (!await supabase.recordAIAttempt(attempt)) logger.error("AI attempt ledger write failed; accounting incomplete");
        }
      } catch { logger.error("AI attempt ledger unavailable; accounting incomplete"); }
    }
  };
}

export function summarizeAIAttempts(since: number) {
  const rows = (accountingScope.getStore() ?? attempts).filter(row => Date.parse(row.started_at) >= since);
  return {
    attempts: rows.length,
    unknownUsage: rows.filter(row => row.total_tokens === null).length,
    totalTokens: rows.reduce((sum, row) => sum + (row.total_tokens ?? 0), 0),
    cost: rows.some(row => row.reported_cost === null) ? null
      : rows.reduce((sum, row) => sum + (row.reported_cost ?? 0), 0),
  };
}
