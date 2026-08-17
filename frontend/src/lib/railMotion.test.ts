import { describe, expect, it } from "vitest";
import {
  railFlipOffsetPx,
  railGeometryScopeId,
  railPresentation,
} from "./railMotion";

describe("rail presentation — one persistent DOM node that stays on screen while the panes travel", () => {
  // Taking the rail off the screen for the phase left 165 points belonging to nobody for 183 to
  // 194ms, on every move that changed which pane it follows — measured 2026-08-17 in a window with a
  // terminal top left, a browser under it and a browser on the right, with the recorded frames
  // showing the strip empty. What travels during a glide is a stand-in, so nothing native crosses
  // the rail, and whether a page is ever drawn over it is a number rather than an assumption
  // (`layout.alignment`, `over`).
  it("keeps identity and stays on screen while moving", () => {
    expect(railPresentation(64, 20, true)).toEqual({
      key: "persistent-rail",
      station: 20,
      fromStation: 64,
      moving: true,
      visible: true,
    });
  });

  it("stays on screen when only the pane moves and the station is unchanged", () => {
    expect(railPresentation(50, 50, true)).toEqual({
      key: "persistent-rail",
      station: 50,
      fromStation: 50,
      moving: false,
      visible: true,
    });
  });

  it("keeps the same identity after landing", () => {
    expect(railPresentation(20, 20, false)).toEqual({
      key: "persistent-rail",
      station: 20,
      fromStation: 20,
      moving: false,
      visible: true,
    });
  });

  it("computes the FLIP offset that reproduces the start position in the final layout from the rail's available width in one expression", () => {
    expect(railFlipOffsetPx(64, 20, 900, 160)).toBeCloseTo(325.6);
    expect(railFlipOffsetPx(20, 64, 900, 160)).toBeCloseTo(-325.6);
  });
});

describe("plane identity", () => {
  it("rail lines of two spaces are not one coordinate system", () => {
    expect(railGeometryScopeId("c38", [0, 50, 100])).not.toBe(
      railGeometryScopeId("c39", [0, 50, 100]),
    );
  });

  it("the same space is a new coordinate system once split or merge changes the line set", () => {
    expect(railGeometryScopeId("c1", [0, 50, 100])).not.toBe(
      railGeometryScopeId("c1", [0, 100 / 3, 200 / 3, 100]),
    );
  });
});
