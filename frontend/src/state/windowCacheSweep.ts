// The boot cache of a window that no longer exists.
//
// A window writes its whole snapshot under `soksak.window.<label>` — the synchronous cache boot
// reads before the core answers — and nothing ever removed one. A label names one window and no other, so
// every window ever opened left an entry behind.
//
// Measured 2026-08-19 on the installation this build runs against: 3,442 cache entries for 2 live
// windows, 2,579,554 of the store's 2,580,350 characters, against a quota of about 2.5 million. The
// authority held four window snapshots and fifteen keys in all, so the leak was the cache alone. It
// had been full long enough that `soksak.windows` — the manifest — was not in the store either: the
// cache had stopped taking writes, and the first anybody knew of it was the window going blank on a
// sidebar drag.
import type { WindowManifest } from "./windowPersistence";

/** The prefix a window's boot cache is written under. One place, so the sweep and the write cannot
 *  disagree about which keys belong to a window. */
export const WINDOW_CACHE_PREFIX = "soksak.window.";

/** The key one window's cache is written under. The writer and the sweep name it here, so a closed
 *  window's cache cannot survive an edit to one of the two spellings. */
export function windowCacheKey(label: string): string {
  return `${WINDOW_CACHE_PREFIX}${label}`;
}

/** Removes one window's cache. Called when the window's slot leaves the ledger: the slot going and
 *  the snapshot staying is what filled the store — the entry is unreachable from that moment and
 *  spends the quota until the next boot sweeps it. */
export function dropWindowCache(label: string): void {
  globalThis.localStorage.removeItem(windowCacheKey(label));
}

/**
 * The cache keys no window will read again.
 *
 * The manifest is the authority for which windows exist: restore reads the slot from it and the
 * snapshot from the cache. A cache entry for a label it does not name can never be reached.
 *
 * A manifest that cannot be read removes nothing. Read as "no slots", one bad boot would sweep every
 * window in the installation — and a slot whose snapshot is gone is a window that never opens again,
 * which is the loss this file exists to avoid causing.
 */
export function staleWindowCacheKeys(
  keys: readonly string[],
  manifest: WindowManifest | null | undefined,
): string[] {
  if (!manifest || !Array.isArray(manifest.slots)) return [];
  const live = new Set(manifest.slots.map((slot) => slot.label));
  return keys.filter(
    (key) => key.startsWith(WINDOW_CACHE_PREFIX) && !live.has(key.slice(WINDOW_CACHE_PREFIX.length)),
  );
}

/** Sweeps them, and answers how many went. Reads the store's own key list rather than a list this
 *  build keeps: an entry written by a build that no longer exists still spends the quota. */
export function sweepWindowCaches(manifest: WindowManifest | null | undefined): number {
  const store = globalThis.localStorage;
  const keys: string[] = [];
  for (let at = 0; at < store.length; at += 1) {
    const key = store.key(at);
    if (key !== null) keys.push(key);
  }
  const stale = staleWindowCacheKeys(keys, manifest);
  for (const key of stale) store.removeItem(key);
  return stale.length;
}
