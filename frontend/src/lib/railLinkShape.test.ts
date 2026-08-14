import { describe, expect, it } from "vitest";
import {
  classifyRailRelation,
  insetClippedEdges,
  railLinkBoxes,
  railLinkPolygon,
  roundedOrthogonalPath,
  splitRightEdgeRounded,
} from "./railLinkShape";

describe("rail link relation shapes", () => {
  it("classifies left adjacency, right adjacency, and detachment from the measured rect by one rule", () => {
    expect(classifyRailRelation(50, { left: 0, top: 0, width: 50, height: 100 })).toBe("left");
    expect(classifyRailRelation(50, { left: 50, top: 0, width: 25, height: 100 })).toBe("right");
    expect(classifyRailRelation(0, { left: 50, top: 0, width: 50, height: 100 })).toBe("detached");
  });
  it("joins a fixed-width rail and the panel directly to its upper right into one L-shaped union", () => {
    const boxes = railLinkBoxes(
      1200,
      800,
      300,
      50,
      { left: 50, top: 0, width: 25, height: 50 },
    );
    expect(boxes).toEqual({
      rail: { x: 450, y: 0, width: 300, height: 800 },
      panel: { x: 750, y: 0, width: 225, height: 400 },
    });
    expect(railLinkPolygon(boxes!.rail, boxes!.panel)).toEqual([
      { x: 450, y: 0 },
      { x: 975, y: 0 },
      { x: 975, y: 400 },
      { x: 750, y: 400 },
      { x: 750, y: 800 },
      { x: 450, y: 800 },
    ]);
  });

  it("a mid-height panel produces only the spur that covers no panel above or below it", () => {
    const polygon = railLinkPolygon(
      { x: 100, y: 0, width: 240, height: 900 },
      { x: 340, y: 225, width: 300, height: 450 },
    );
    expect(polygon).toEqual([
      { x: 100, y: 0 }, { x: 340, y: 0 }, { x: 340, y: 225 },
      { x: 640, y: 225 }, { x: 640, y: 675 }, { x: 340, y: 675 },
      { x: 340, y: 900 }, { x: 100, y: 900 },
    ]);
  });

  it("another area between the rail and the panel produces no false link surface", () => {
    expect(railLinkPolygon(
      { x: 0, y: 0, width: 240, height: 900 },
      { x: 500, y: 0, width: 300, height: 450 },
    )).toBeNull();
  });

  it("radius 0 gives a square path, a positive radius gives a Q curve path, and neither mutates the input", () => {
    const points = [
      { x: 0, y: 0 }, { x: 100, y: 0 },
      { x: 100, y: 50 }, { x: 0, y: 50 },
    ];
    const before = structuredClone(points);
    expect(roundedOrthogonalPath(points, 0)).toBe("M 0 0 L 100 0 L 100 50 L 0 50 Z");
    expect(roundedOrthogonalPath(points, 10)).toContain("Q 100 0 100 10");
    expect(points).toEqual(before);
  });

  it("insets only the stroke on the outer clip boundary by half the line width and keeps the inner grid lines", () => {
    expect(insetClippedEdges([
      { x: 300, y: 0 }, { x: 1200, y: 0 },
      { x: 1200, y: 800 }, { x: 300, y: 800 },
    ], 1200, 800, 0.75)).toEqual([
      { x: 300, y: 0.75 }, { x: 1199.25, y: 0.75 },
      { x: 1199.25, y: 799.25 }, { x: 300, y: 799.25 },
    ]);
  });
});

describe("right edge split (option B — dashed outer edge, rounding preserved)", () => {
  // Measured defect: the split render dropped the corner arcs and the two right corners came out
  // square ("it should be rounded like before"). Contract: the corner arcs are part of the solid
  // path, and the dashed part is only the straight run between the two arcs — the outer shape
  // must be identical to the unsplit one.
  const squareR = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 8 },
    { x: 0, y: 8 },
  ];

  it("splitRightEdgeRounded: the dashed part is the straight run between the arcs, the solid part is an open path including the arcs", () => {
    const split = splitRightEdgeRounded(squareR, 2)!;
    expect(split.edge).toEqual([
      { x: 10, y: 2 },
      { x: 10, y: 6 },
    ]);
    expect(split.solid.startsWith("M 10 6 Q 10 8")).toBe(true); // starts with the B corner arc
    expect(split.solid.endsWith("Q 10 0 10 2")).toBe(true); // ends with the A corner arc
    expect(split.solid.includes("Z")).toBe(false);
  });

  // Rectangular polygon (clockwise): (0,0)→(10,0)→(10,8)→(0,8). Rightmost vertical edge = (10,0)-(10,8).


});

/** The host defines the reference width. The panel area is the host minus the rail only — the
 *  rail is placed *inside* the host. Anything placed outside the host (a push sidebar) is not
 *  subtracted here: when it is present, the host itself is already that much narrower.
 *
 *  Re-legislated (2026-08-02): the old standard was "subtract the right push width too", and
 *  that check was in this spot. It was wrong — measurement showed the border drawn in push mode
 *  was shorter than the joined panel by exactly the sidebar width (window 1017 vs 1336, host
 *  width 1204 vs 1529 in overlay mode). One more thing to subtract gets counted twice sooner or
 *  later. The argument is gone, so there is no place left to get it wrong. */
describe("panel area — the host is the reference", () => {
  it("the panel area is the host minus the rail only", () => {
    const b = railLinkBoxes(1000, 500, 100, 0, { left: 0, top: 0, width: 100, height: 100 });
    expect(b?.panel.width).toBe(900);
  });

  it("a full-width box ends at the host right edge — anything shorter leaves the border short of the panel", () => {
    const b = railLinkBoxes(1000, 500, 100, 0, { left: 0, top: 0, width: 100, height: 100 });
    expect((b?.panel.x ?? 0) + (b?.panel.width ?? 0)).toBe(1000);
  });
});
