// Ownership of the rail's vertical edge lines — who draws the line is the composition of railLook and
// the theme paneStyle. In ground mode the rail draws no line of its own as a rule: the neighbor (pane
// card outline / divider) draws the border, so a rail line on top makes a double line. But **flat
// themes draw no neighbor outline at all**, so that delegation does not hold — measured (Bare light):
// the sidebar-feature border vanished with no line. Under flat the ground rail draws its own borders
// (1px on both sides). pane mode keeps the existing rule.
import { describe, expect, it } from "vitest";
import { railEdgeWidths } from "./railEdges";

describe("railEdgeWidths", () => {
  it("ground + card/floating: delegated to the neighbor (card outline) — 0 on both sides", () => {
    expect(railEdgeWidths("ground", true, 50, "card")).toEqual({ left: 0, right: 0 });
    expect(railEdgeWidths("ground", true, 0, "floating")).toEqual({ left: 0, right: 0 });
  });

  it("ground + flat: the neighbor draws nothing, so the rail owns the seam — 0 on the outer edge", () => {
    // The delegation argument holds only for a seam between two surfaces. The outer edge of the window
    // has no counterpart surface to divide from, and the OS window frame already covers that border
    // (§B2a) — measured 2026-08-15: rail left x=0 was drawn, panel right x=1000 was not.
    expect(railEdgeWidths("ground", true, 50, "flat")).toEqual({ left: 1, right: 1 });
    expect(railEdgeWidths("ground", true, 0, "flat")).toEqual({ left: 1, right: 1 });
    expect(railEdgeWidths("ground", true, 100, "flat")).toEqual({ left: 1, right: 1 });
  });

  it("pane: 1px on both sides for an inner station, 0 on the outer edge — independent of paneStyle", () => {
    expect(railEdgeWidths("pane", true, 50, "flat")).toEqual({ left: 1, right: 1 });
    expect(railEdgeWidths("pane", true, 0, "card")).toEqual({ left: 0, right: 1 });
    expect(railEdgeWidths("pane", true, 100, "flat")).toEqual({ left: 1, right: 0 });
  });

  it("closed: 0 on both sides regardless of mode and theme", () => {
    expect(railEdgeWidths("pane", false, 50, "flat")).toEqual({ left: 0, right: 0 });
    expect(railEdgeWidths("ground", false, 50, "card")).toEqual({ left: 0, right: 0 });
  });
});
