/**
 * Shared utility helpers.
 */

/** Sleep for the given number of milliseconds. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
