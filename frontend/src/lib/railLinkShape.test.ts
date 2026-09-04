import { describe, expect, it } from "vitest";
import {
  insetClippedEdges,
  railLinkBoxes,
  railLinkPolygon,
  railSeamX,
  roundedOrthogonalPath,
  splitRightEdgeRounded,
} from "./railLinkShape";
import { classifyRailRelation } from "./railArrangement";

describe("rail link relation shapes", () => {
  it("classifies left adjacency, right adjacency, and detachment across the corridor by one rule", () => {
    const rail = { left: 500, top: 0, width: 300, height: 800 };
    expect(classifyRailRelation(rail, { left: 0, top: 0, width: 490, height: 800 }, 10)).toBe("left");
    expect(classifyRailRelation(rail, { left: 810, top: 0, width: 200, height: 800 }, 10)).toBe("right");
    expect(classifyRailRelation(rail, { left: 900, top: 0, width: 100, height: 800 }, 10)).toBe("detached");
  });
  it("joins a fixed-width rail and the panel directly to its upper right into one L-shaped union", () => {
    const boxes = railLinkBoxes(
      { left: 450, top: 0, width: 300, height: 800 },
      { left: 750, top: 0, width: 225, height: 400 },
      0,
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

/** The plane's origin is the host inset by the pane inset (UI-GEOMETRY R1b), so a rect on the plane
 *  becomes a rect in the host by that offset alone — the rail and the linked panel share it. */
describe("boxes in the host — the plane's origin is the inset", () => {
  it("offsets the rail and the panel by the pane inset", () => {
    const b = railLinkBoxes(
      { left: 0, top: 0, width: 310, height: 525 },
      { left: 320, top: 0, width: 669, height: 157.5 },
      5,
    );
    expect(b).toEqual({
      rail: { x: 5, y: 5, width: 310, height: 525 },
      panel: { x: 325, y: 5, width: 669, height: 157.5 },
    });
  });

  // Two cards on one plane never touch (split-pane R5): the seam is the centre of the corridor.
  it("draws the seam through the corridor between the rail and the panel beside it", () => {
    const rail = { x: 100, y: 0, width: 240, height: 900 };
    expect(railSeamX(rail, { x: 350, y: 0, width: 300, height: 450 }, 10)).toBe(345);
    expect(railSeamX(rail, { x: 0, y: 0, width: 90, height: 450 }, 10)).toBe(95);
    expect(railSeamX(rail, { x: 500, y: 0, width: 300, height: 450 }, 10)).toBeNull();
  });
});
