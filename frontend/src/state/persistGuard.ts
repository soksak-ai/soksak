// Do not overwrite what is known with what is unknown — after a failed restore, do not persist.
//
// An empty state has two faces: "the user closed everything" and "the restore failed". The first
// is user intent and must be saved; the second is a state where nothing is known yet, and saving
// it **erases what was known.**
//
// Measured 2026-08-01, three times: a restore died on an exception, the window went empty, and
// that empty state was saved immediately over the snapshot (10KB → 32 bytes). A restore failure
// can be temporary, but an overwrite is permanent — without the backup ring three user workspaces
// would have been gone.
//
// [RULE] **Unread is not empty.** The store owner is a separate process (cored), so a read can
// fail. Recording that failure as the number 0 makes it **the same value** as "a window that was
// empty", and the guard opens the door at that moment — the third loss (measured 13:24) took
// exactly that path. So this file takes the read result not as a number but as a **value that
// shows whether it was read**. Unread cannot be expressed as 0.

/** The snapshot read result. Whether it was read is part of the value, so unread cannot disguise
 *  itself as the number 0. */
export type SnapshotRead = { read: true; projects: number } | { read: false };

/** Read — the snapshot held this many projects (0 means it really was empty). */
export function snapshotRead(projects: number): SnapshotRead {
  return { read: true, projects };
}

/** Unread — the store did not answer. What it holds is unknown. */
export function snapshotUnread(): SnapshotRead {
  return { read: false };
}

/** The facts that separate persisting from not persisting. The verdict uses only these values. */
export interface PersistFacts {
  /** The result of reading the snapshot at restore time. This is "what was known". */
  snapshot: SnapshotRead;
  /** The number of projects the restore actually created (after the P6 drop). */
  restoredProjects: number;
  /** The number of projects in this window right now. */
  liveProjects: number;
}

/**
 * Whether the current state may be persisted.
 *
 * Two cases block it.
 *
 *  1. **Unread.** What would be overwritten is unknown, so nothing is written. That holds even
 *     when this window is full — "it is full, so it is safe" only holds when what lies underneath
 *     is known. The third loss was one project created by the default boot overwriting the three
 *     in the snapshot.
 *  2. **Something was known, none of it was recovered, and it is still empty.** That empty state
 *     is not user intent but the trace of a failed restore, and saving it erases what was known.
 *
 * A partial recovery is not a failure — dropping a root occupied by another window is the rule
 * (P6).
 */
export function mayPersist(f: PersistFacts): boolean {
  if (!f.snapshot.read) return false;
  if (f.snapshot.projects === 0) return true;
  if (f.restoredProjects > 0 || f.liveProjects > 0) return true;
  return false;
}

/**
 * A window that could not read at boot **read again right before writing.** Whether that result
 * may be adopted as the boot fact.
 *
 * Never writing again after one failed read is also a loss — so there must be a way to read again.
 * But if the late read **produces content**, this window never restored it. Saving in that state
 * lets a window that restored nothing overwrite someone else's content — the very thing this
 * blocks.
 *
 * So adoption happens **only when it is empty**. Empty means there is nothing to overwrite, so
 * writing proceeds normally; full means no write (the correct recovery for that window is another
 * restore, not a save).
 */
export function mayAdoptLateRead(projects: number): boolean {
  return projects === 0;
}
