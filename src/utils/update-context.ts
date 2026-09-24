import { AsyncLocalStorage } from "node:async_hooks";

const updates = new AsyncLocalStorage<{ pending: Promise<unknown>[]; failure?: Error }>();

export function trackUpdateWork<T>(work: Promise<T>): Promise<T> {
  const context = updates.getStore();
  if (context) context.pending.push(work);
  else void work.catch(error => process.emitWarning(`Telegram handler failed: ${error instanceof Error ? error.message : "unknown error"}`));
  return work;
}

export function markUpdateIncomplete(): void {
  const context = updates.getStore();
  if (context) context.failure = new Error("Command response incomplete; do not replay automatically");
}

export async function awaitUpdateWork(dispatch: () => void): Promise<void> {
  await updates.run({ pending: [] }, async () => {
    dispatch();
    const context = updates.getStore()!;
    let offset = 0;
    while (offset < context.pending.length) {
      const batch = context.pending.slice(offset);
      offset += batch.length;
      const results = await Promise.allSettled(batch);
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") context.failure = failure.reason;
    }
    if (context.failure) throw context.failure;
  });
}
