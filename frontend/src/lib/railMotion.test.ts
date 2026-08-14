import { describe, expect, it } from "vitest";
import {
  railFlipOffsetPx,
  railGeometryScopeId,
  railPresentation,
} from "./railMotion";

describe("rail presentation — one persistent DOM node, removed while moving and visible again at the destination", () => {
  it("keeps identity while moving and does not expose the rail surface", () => {
    expect(railPresentation(64, 20, true)).toEqual({
      key: "persistent-rail",
      station: 20,
      fromStation: 64,
      moving: true,
      visible: false,
    });
  });

  it("exposes neither the rail surface nor the structural outline while moving, even when only the pane moves and the station is unchanged", () => {
    expect(railPresentation(50, 50, true)).toEqual({
      key: "persistent-rail",
      station: 50,
      fromStation: 50,
      moving: false,
      visible: false,
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
