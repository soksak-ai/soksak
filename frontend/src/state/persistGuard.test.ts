// Do not overwrite what is known with what is unknown — after a failed restore, do not persist.
//
// Measured (2026-08-01, three times): the restore path died on an exception, the window ended
// up empty, and that empty state was persisted immediately over the snapshot (10KB → 32 bytes).
// Three user workspaces disappeared that way, recoverable only from the backup ring. A restore
// failure can be transient; an overwrite is permanent.
//
// An empty state has two causes: "the user closed everything" and "the restore failed". The
// first must be persisted, the second must not. One fact separates them — what the snapshot
// held.
//
// That fact itself can be unreadable. The store owner is a separate process (cored), so the
// read fails when it is not attached — the third loss (measured 13:24) took that path. Writing
// the failure down as count 0 makes it equal to "a window that was empty to begin with", and
// the guard opens. Unread is not empty.
import { describe, it, expect } from "vitest";
import { mayPersist, mayAdoptLateRead, snapshotRead, snapshotUnread } from "./persistGuard";

describe("a failed restore blocks the persist", () => {
  it("there was something to restore and none of it came back — do not persist", () => {
    expect(
      mayPersist({ snapshot: snapshotRead(3), restoredProjects: 0, liveProjects: 0 }),
    ).toBe(false);
  });

  it("the user closed everything — persist; the restore succeeded and the emptying came after", () => {
    expect(
      mayPersist({ snapshot: snapshotRead(3), restoredProjects: 3, liveProjects: 0 }),
    ).toBe(true);
  });

  it("a window that started from an empty snapshot — persist; there is nothing to overwrite", () => {
    expect(
      mayPersist({ snapshot: snapshotRead(0), restoredProjects: 0, liveProjects: 0 }),
    ).toBe(true);
  });

  it("only part came back — persist; a drop is the rule (P6), not a failure", () => {
    expect(
      mayPersist({ snapshot: snapshotRead(3), restoredProjects: 1, liveProjects: 1 }),
    ).toBe(true);
  });

  it("a project is present now — persist; whatever filled it, there is no overwrite risk", () => {
    expect(
      mayPersist({ snapshot: snapshotRead(3), restoredProjects: 0, liveProjects: 2 }),
    ).toBe(true);
  });
});

describe("unread is not empty", () => {
  it("the snapshot was unreadable — do not persist; what would be overwritten is unknown", () => {
    expect(
      mayPersist({ snapshot: snapshotUnread(), restoredProjects: 0, liveProjects: 0 }),
    ).toBe(false);
  });

  it("unread — do not persist even when the window is full now; what is underneath is unknown", () => {
    // Shape of the third loss: the read failed, the window put up one project from the default
    // boot, and that one overwrote three. "Non-empty now, so it is safe" holds only for a
    // window that read the snapshot.
    expect(
      mayPersist({ snapshot: snapshotUnread(), restoredProjects: 0, liveProjects: 2 }),
    ).toBe(false);
  });

  it("unread is not written down as a number — the moment it equals 0 the guard opens", () => {
    const unread = snapshotUnread();
    const empty = snapshotRead(0);
    expect(unread).not.toEqual(empty);
    expect(mayPersist({ snapshot: unread, restoredProjects: 0, liveProjects: 0 })).toBe(false);
    expect(mayPersist({ snapshot: empty, restoredProjects: 0, liveProjects: 0 })).toBe(true);
  });
});

describe("a late read is adopted only when it is empty", () => {
  it("the late read is empty — adopt it; there is nothing to overwrite", () => {
    expect(mayAdoptLateRead(0)).toBe(true);
  });

  it("the late read is not empty — do not adopt it; a window that never restored would overwrite it", () => {
    expect(mayAdoptLateRead(3)).toBe(false);
    expect(mayAdoptLateRead(1)).toBe(false);
  });

  it("not adopted — the persist stays blocked; a late read does not bypass the guard", () => {
    const late = 3;
    const snapshot = mayAdoptLateRead(late) ? snapshotRead(late) : snapshotUnread();
    expect(mayPersist({ snapshot, restoredProjects: 0, liveProjects: 1 })).toBe(false);
  });
});
