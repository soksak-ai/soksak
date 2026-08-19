// Writing a preference down never takes the window with it.
//
// A width, a mode, a last-used tab: none of them is the authority for anything. The authority is
// the core's store; this is the synchronous cache boot reads before the core answers. So a failed
// write costs the cache and nothing else.
//
// It cost the window. Measured 2026-08-19: `localStorage` was full, the sidebar resize wrote the
// new width from inside a React state updater, `setItem` threw `QuotaExceededError` during the
// commit, and the window went blank — dragging the boundary blanked the application. A throw during
// render takes the whole tree (SIDEBAR S1 measured the same class: exposed nodes 64 → 0).
//
// Swallowed is not the answer either. A cache that silently stops taking writes is a window whose
// settings quietly stop being remembered, and nobody can be told why. The failure is kept and the
// health surface reports it.
import { moduleState } from "./moduleState";

/** One failed write, kept until it succeeds again. */
export interface PreferenceWriteFailure {
  key: string;
  reason: string;
  atUnixMs: number;
}

const box = moduleState("lib/preferenceStore#failures", () => ({
  failures: new Map<string, PreferenceWriteFailure>(),
}));

/**
 * Writes a preference, and answers whether it landed.
 *
 * Never throws. The caller continues with the value it already has — the write is a note for the
 * next boot, not the thing that makes this one correct.
 */
export function writePreference(key: string, value: string, nowUnixMs: number): boolean {
  try {
    globalThis.localStorage.setItem(key, value);
    box.failures.delete(key);
    return true;
  } catch (e) {
    box.failures.set(key, { key, reason: String(e), atUnixMs: nowUnixMs });
    return false;
  }
}

/** Every key whose last write failed, oldest first. Empty is the ordinary state. */
export function preferenceWriteFailures(): PreferenceWriteFailure[] {
  return [...box.failures.values()].sort((a, b) => a.atUnixMs - b.atUnixMs);
}

/** What the window has written, by key, with the size of each value in characters.
 *
 *  A quota is spent by something, and until this there was no way to ask what. The reading is of
 *  the store itself rather than of a list of this build's own keys: a key written by a build that no
 *  longer exists still spends the quota, and a list of our own keys would not show it. */
export function preferenceStoreContents(): {
  keys: Array<{ key: string; chars: number }>;
  totalChars: number;
} {
  const store = globalThis.localStorage;
  const keys: Array<{ key: string; chars: number }> = [];
  for (let at = 0; at < store.length; at += 1) {
    const key = store.key(at);
    if (key === null) continue;
    keys.push({ key, chars: (store.getItem(key) ?? "").length });
  }
  keys.sort((a, b) => b.chars - a.chars);
  return { keys, totalChars: keys.reduce((sum, one) => sum + one.chars, 0) };
}

/** Test seam — a failure list that outlives one case is a case that passes because of another. */
export function __resetPreferenceStoreForTest(): void {
  box.failures.clear();
}
