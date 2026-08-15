// A snapshot this build does not recognise is skipped by name, not crashed on.
//
// Measured 2026-08-16 after a cold restart: nothing came back. Every window snapshot was in the
// store and the ledger held 23 restorable slots, and the boot facts read
//   respawn:slots:23:live:1:restorable:23
//   respawn:error:TypeError: undefined is not an object (evaluating 'a.workspaces.length')
//
// Two of those snapshots were written before the project → workspace rename and carry `projects`
// where this build reads `workspaces`. Reading `.length` on the missing field threw, the throw left
// the loop, and every one of the twenty-three windows stayed closed — including the twenty-one this
// build had written itself.
//
// One unreadable record must cost that record only. The name goes in the boot facts so the reason
// is readable from outside rather than inferred from an empty screen.
import { describe, expect, it } from "vitest";

import { readableWindowSnapshot } from "./windowSnapshotShape";

describe("reading a stored window snapshot", () => {
  it("a snapshot of this build's shape is readable", () => {
    expect(readableWindowSnapshot({ activeId: "wsp-aaaaaa", workspaces: [] })).toEqual({
      ok: true,
      snapshot: { activeId: "wsp-aaaaaa", workspaces: [] },
    });
  });

  it("a snapshot from before the rename is refused by what is wrong with it", () => {
    const verdict = readableWindowSnapshot({ activeId: "wsp-aaaaaa", projects: [{ id: "wsp-aaaaaa" }] });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.why).toContain("workspaces");
  });

  it("a missing activeId is refused", () => {
    // Restoring workspaces with no active one leaves a window with panes and nothing selected,
    // which reads as a blank screen with content behind it.
    const verdict = readableWindowSnapshot({ workspaces: [] });
    expect(verdict.ok).toBe(false);
  });

  it("anything that is not an object is refused rather than coerced", () => {
    for (const value of [null, undefined, 3, "workspaces", []]) {
      expect(readableWindowSnapshot(value).ok, String(value)).toBe(false);
    }
  });

  it("an empty workspace list is readable — a window the user emptied is a real state", () => {
    // Refusing it here would make "the user closed everything" indistinguishable from "the record
    // is broken", and the two are handled differently: one prunes the slot, the other keeps it.
    expect(readableWindowSnapshot({ activeId: "", workspaces: [] }).ok).toBe(true);
  });
});
