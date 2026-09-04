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

// A split node with no id is a record this build cannot read.
//
// Every id survives a restart (NAMING N2a), with no exception: a reader that had
// to know which kind of id it was holding before it could tell whether the name
// would still be there is the shape that cost a day on 2026-08-16.
//
// The split node's id went into the snapshot that day. A record written before
// it has none, and this build keeps no old paths: no fallback
// that mints a name, no migration that rewrites the record. It is refused by
// name, it costs that record only, and the ledger slot stays (R1).
describe("a space's plane", () => {
  const withSpace = (space: Record<string, unknown>) => ({
    activeId: "wsp-aaaaaa",
    workspaces: [
      {
        id: "wsp-aaaaaa",
        railPlacement: { mode: "flow" },
        contents: [{ id: "spc-aaaaaa", activeGroupId: "pan-aaaaaa", ...space }],
      },
    ],
  });
  const onePane = {
    groups: [{ id: "pan-aaaaaa", activeViewId: "", views: [] }],
    plane: { xs: [0, 1], ys: [0, 1], cards: [{ id: "pan-aaaaaa", c0: 0, c1: 1, r0: 0, r1: 1 }] },
  };

  it("a record this build wrote is read", () => {
    expect(readableWindowSnapshot(withSpace(onePane)).ok).toBe(true);
  });

  it("a split tree in place of a plane is refused, and the reason names the date", () => {
    const verdict = readableWindowSnapshot(withSpace({
      groups: onePane.groups,
      layout: { t: "s", id: "spl-aaaaaa", dir: "row", sizes: [1], children: [{ t: "l", v: { id: "pan-aaaaaa" } }] },
    }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toContain("no plane");
    expect(verdict.why).toContain("2026-09-05");
  });

  it("a plane the library refuses is refused with the library's reason", () => {
    const verdict = readableWindowSnapshot(withSpace({
      groups: onePane.groups,
      plane: { xs: [0, 1], ys: [0, 1], cards: [{ id: "pan-aaaaaa", c0: 0, c1: 2, r0: 0, r1: 1 }] },
    }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toContain("cannot read");
  });

  it("panes and plane must name the same ids", () => {
    const verdict = readableWindowSnapshot(withSpace({ groups: [], plane: onePane.plane }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toContain("pan-aaaaaa");
  });

});

// The sidebar's arrangement is still a split tree, and its nodes carry ids too (NAMING N2a).
describe("a sidebar split node with no id", () => {
  const withSidebar = (layout: unknown) => ({
    activeId: "wsp-aaaaaa",
    workspaces: [
      {
        id: "wsp-aaaaaa",
        railPlacement: { mode: "flow" },
        contents: [],
        sidebarLayouts: { left: layout },
      },
    ],
  });

  it("is refused, and the reason names what is missing", () => {
    const verdict = readableWindowSnapshot(
      withSidebar({ t: "s", dir: "row", sizes: [1], children: [{ t: "l", v: { viewKeys: [], activeViewKey: "" } }] }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toContain("split");
    expect(verdict.why).toContain("id");
  });

  it("a record this build wrote is read", () => {
    const verdict = readableWindowSnapshot(
      withSidebar({ t: "s", id: "spl-aaaaaa", dir: "row", sizes: [1], children: [{ t: "l", v: { viewKeys: [], activeViewKey: "" } }] }),
    );
    expect(verdict.ok).toBe(true);
  });
});
