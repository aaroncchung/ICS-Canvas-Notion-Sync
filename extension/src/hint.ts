// Shared by the worker and the Canvas page script, which are built as separate bundles.

/** The `chrome.storage.session` key under which the worker says when the next scan is due. */
export const HINT = "quiet-hint";
/** The Canvas the hint is for, and when its next automatic scan is due, in epoch milliseconds. */
export interface Hint {
  origin: string;
  until: number;
}
/** The most failures or a Retry-After header may hold automatic scans back; Sync now never waits. */
export const LONGEST_COOLDOWN = 60 * 60_000;
