// A restore is judged by comparing two moments, and the two are in different processes.
//
// state.tree, layout.arrangement and surface.composition each answer part of what a window holds.
// Comparing three answers by hand across a restart puts the rule in whoever is comparing, and two
// people comparing the same restart can disagree about it. This is one digest of the three, plus
// the parts it was built from, so a mismatch names which one moved.
//
// It is a digest of what the layout *is*, not of the ids it happens to hold: a restore regenerates
// split ids by contract (A2), so a fingerprint that counted them would never match and the gate
// would be unusable on the one thing it exists for.
import { describe, expect, it } from "vitest";

import { fingerprintOf } from "./stateFingerprint";

const layout = {
  workspaces: [
    {
      id: "wsp-aaaaaa",
      root: "/tmp/a",
      railPosition: { mode: "flow", effectiveStation: 50, cleanLines: [0, 50, 100] },
      spaces: [
        {
          id: "spc-aaaaaa",
          activePaneId: "pan-bbbbbb",
          panes: [
            { id: "pan-aaaaaa", rect: { left: 0, top: 0, width: 50, height: 100 } },
            { id: "pan-bbbbbb", rect: { left: 50, top: 0, width: 50, height: 100 } },
          ],
        },
      ],
    },
  ],
};

describe("the state fingerprint", () => {
  it("is the same for the same layout", () => {
    expect(fingerprintOf(layout).digest).toBe(fingerprintOf(structuredClone(layout)).digest);
  });

  it("changes when a pane's rectangle changes", () => {
    const moved = structuredClone(layout);
    moved.workspaces[0].spaces[0].panes[1].rect.left = 60;
    expect(fingerprintOf(moved).digest).not.toBe(fingerprintOf(layout).digest);
  });

  it("changes when the rail station changes", () => {
    const pinned = structuredClone(layout);
    pinned.workspaces[0].railPosition.effectiveStation = 0;
    expect(fingerprintOf(pinned).digest).not.toBe(fingerprintOf(layout).digest);
  });

  it("changes when the active pane changes", () => {
    // The focused pane is what the rail stands beside and what the light is on. A restore that
    // brought the panes back and focused another one is not the same window.
    const refocused = structuredClone(layout);
    refocused.workspaces[0].spaces[0].activePaneId = "pan-aaaaaa";
    expect(fingerprintOf(refocused).digest).not.toBe(fingerprintOf(layout).digest);
  });

  it("does not change when the ids change but the shape does not", () => {
    // A restore regenerates split ids by contract (A2). A fingerprint that counted them could never
    // match across the one event it exists to judge.
    const renamed = structuredClone(layout);
    renamed.workspaces[0].spaces[0].panes[0].id = "pan-zzzzzz";
    renamed.workspaces[0].spaces[0].panes[1].id = "pan-yyyyyy";
    renamed.workspaces[0].spaces[0].activePaneId = "pan-yyyyyy";
    renamed.workspaces[0].id = "wsp-zzzzzz";
    renamed.workspaces[0].spaces[0].id = "spc-zzzzzz";
    expect(fingerprintOf(renamed).digest).toBe(fingerprintOf(layout).digest);
  });

  it("does change when a workspace root changes, because that is not an id", () => {
    // The root is the workspace's identity (P4). Two windows holding different roots are not the
    // same window however alike their panes are.
    const elsewhere = structuredClone(layout);
    elsewhere.workspaces[0].root = "/tmp/b";
    expect(fingerprintOf(elsewhere).digest).not.toBe(fingerprintOf(layout).digest);
  });

  it("carries the parts it was built from, so a mismatch says which one moved", () => {
    const print = fingerprintOf(layout);
    expect(print.workspaces).toHaveLength(1);
    expect(print.workspaces[0].root).toBe("/tmp/a");
    expect(print.workspaces[0].station).toBe(50);
    expect(print.workspaces[0].spaces[0].panes).toEqual([
      { rect: { left: 0, top: 0, width: 50, height: 100 }, active: false },
      { rect: { left: 50, top: 0, width: 50, height: 100 }, active: true },
    ]);
  });

  it("orders workspaces by root, so two windows in a different order still match", () => {
    const swapped = structuredClone(layout);
    swapped.workspaces.push(structuredClone(layout.workspaces[0]));
    swapped.workspaces[1].root = "/tmp/b";
    const reversed = structuredClone(swapped);
    reversed.workspaces.reverse();
    expect(fingerprintOf(reversed).digest).toBe(fingerprintOf(swapped).digest);
  });
});
