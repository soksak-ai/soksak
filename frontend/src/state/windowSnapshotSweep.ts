// Which stored window snapshots are for windows that will not come back.
//
// Measured 2026-08-16: the ledger held 3 slots and the store held 24 window snapshots. Every run
// that opened a window and closed it left its record behind for good, and one of the leftovers —
// written before the project → workspace rename — was what crashed the whole restore.
//
// The ledger is the record of what comes back. A snapshot no slot names is data nobody reads,
// growing without bound, and a shape from a build that no longer exists waiting to be tripped over.

const PREFIX = "window/";

/**
 * The keys to forget.
 *
 * live names the windows open right now. A window that has never been closed is legitimately absent
 * from the ledger — the ledger is written on close — so sweeping by the ledger alone would delete
 * the record of the window a person is looking at.
 *
 * Keys outside this prefix are left alone. The sweep runs over the whole namespace, and taking one
 * it does not own would delete the settings, the plugin consents, or the ledger it just read.
 */
export function snapshotsToForget(
  keys: readonly string[],
  slotLabels: readonly string[],
  live: readonly string[] = [],
): string[] {
  const keep = new Set([...slotLabels, ...live]);
  return keys.filter((key) => key.startsWith(PREFIX) && !keep.has(key.slice(PREFIX.length)));
}
