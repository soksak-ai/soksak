// A window snapshot outlives its slot, and nothing ever removes it.
//
// Measured 2026-08-16: the ledger held 3 slots and the store held 24 window snapshots. Every run
// that opened a window and closed it left its record behind for good, and one of the leftovers —
// written before the project → workspace rename — was what crashed the whole restore.
//
// The ledger is the record of what should come back. A snapshot no slot names is for a window that
// will not: it is data nobody reads, growing without bound, and a shape from a build that no longer
// exists waiting for something to trip over.
import { describe, expect, it } from "vitest";

import { snapshotsToForget } from "./windowSnapshotSweep";

describe("sweeping window snapshots", () => {
  it("names a snapshot no slot claims", () => {
    expect(
      snapshotsToForget(
        ["window/win-a", "window/win-b", "window/win-c"],
        ["win-a", "win-c"],
      ),
    ).toEqual(["window/win-b"]);
  });

  it("keeps every snapshot a slot claims", () => {
    expect(snapshotsToForget(["window/win-a"], ["win-a"])).toEqual([]);
  });

  it("leaves keys that are not window snapshots alone", () => {
    // The sweep runs over the whole namespace. Taking a key it does not own would delete settings,
    // the plugin consents, or the ledger it is reading from.
    expect(
      snapshotsToForget(["settings", "windows", "recentWorkspaces", "window/win-b"], []),
    ).toEqual(["window/win-b"]);
  });

  it("keeps the live window even when the ledger has not caught up", () => {
    // A window open right now will come back, whatever the ledger holds. The
    // ledger is written on close, so a window that has never been closed is legitimately absent
    // from it, and sweeping it would delete the record of the window a person is looking at.
    expect(snapshotsToForget(["window/win-a"], [], ["win-a"])).toEqual([]);
  });

  it("an empty ledger with nothing live sweeps every snapshot", () => {
    // Not a special case: no slot and no window means nothing comes back, and every record is for
    // a window that will not.
    expect(snapshotsToForget(["window/win-a", "window/win-b"], [])).toEqual([
      "window/win-a",
      "window/win-b",
    ]);
  });
});
