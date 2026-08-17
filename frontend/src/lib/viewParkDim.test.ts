import { describe, expect, it } from "vitest";
import { viewSurfacePlacement } from "./viewPark";

// The dim travels with the placement, because a surface cannot be reached by the veil.
//
// The focus lighting is an SVG painted over the document, and a native surface is composited above
// it. Measured on the running build 2026-08-17: the same rectangle inside a browser page read a mean
// brightness of 184.7 whether its pane was focused or not, while the CSS above that veil stated it
// painted "over a native child outside the document".
//
// So the strength the veil paints by travels to the view as a number, and a view drawn on a surface
// applies it to that surface's own alpha. One rule, computed once, read by the cell, the slot and
// the surface.
describe("the dim a view is presented with", () => {
  it("travels with the same object as its visibility", () => {
    expect(viewSurfacePlacement(true, false, 0.5)).toMatchObject({
      desiredVisible: true,
      dim: 0.5,
    });
  });

  it("is carried by a hidden view too, so it does not arrive late when it is shown again", () => {
    expect(viewSurfacePlacement(false, false, 0.7).dim).toBe(0.7);
    expect(viewSurfacePlacement(false, true, 0.7).dim).toBe(0.7);
  });

  it("is nothing when nobody supplied one", () => {
    // A host that reports no dim leaves the view at full brightness rather than guessing one.
    expect(viewSurfacePlacement(true, false).dim).toBe(0);
  });
});
