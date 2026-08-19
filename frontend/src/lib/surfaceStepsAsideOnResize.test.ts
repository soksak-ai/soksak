// @vitest-environment jsdom
// While the panes are moving, the page is not on the screen — its picture is.
//
// A native surface is composited above the document and its position is written across a round
// trip, so between two commits it is showing where the pane used to be. A rail travel already
// steps the surface aside and lets the document draw the page's picture in the slot, which moves
// with the pane by the same transform and cannot be out of place.
//
// A width drag moves every pane the same way and did not do it. Measured 2026-08-19, dragging the
// window's left edge in `push`: the page and its pane 200 points apart, 15 of 21 frames out of
// line, while `surface.composition` answered `worst 0` — the native layer had applied the
// declaration exactly, and the declaration itself was a commit behind.
//
// Both facts are true, and only one of them is fixable at this layer: a declaration cannot be
// made instant. So the surface steps aside for a resize as it does for a travel, and there is
// nothing left that can disagree.
import { beforeEach, describe, expect, it } from "vitest";
import { beginLayoutMotion, endLayoutMotion } from "./layoutMotion";
import { panesAreMoving, surfaceShown } from "./viewPark";

describe("whether the panes are moving", () => {
  beforeEach(() => {
    // Motion counts are module state — a phase left open by one case is a case that passes because
    // of another.
    for (const kind of ["move", "resize"] as const) {
      for (let at = 0; at < 4; at += 1) endLayoutMotion(kind);
    }
  });

  it("is true while a width drag is open", () => {
    expect(panesAreMoving([])).toBe(false);
    beginLayoutMotion("resize");
    expect(panesAreMoving([])).toBe(true);
    endLayoutMotion("resize");
    expect(panesAreMoving([])).toBe(false);
  });

  it("is true while a travel carries moves, with no motion phase of its own", () => {
    expect(panesAreMoving(["tab-aaaaaa"])).toBe(true);
  });

  it("stays true while a drag and a travel overlap, and until both are done", () => {
    // A drag that starts mid-travel and ends first would otherwise put the surface back while the
    // panes are still going.
    beginLayoutMotion("move");
    beginLayoutMotion("resize");
    endLayoutMotion("resize");
    expect(panesAreMoving([])).toBe(true);
    endLayoutMotion("move");
    expect(panesAreMoving([])).toBe(false);
  });

  it("takes the surface off the screen for the whole of it", () => {
    beginLayoutMotion("resize");
    expect(surfaceShown(true, true, true, false, panesAreMoving([]))).toBe(false);
    endLayoutMotion("resize");
    expect(surfaceShown(true, true, true, false, panesAreMoving([]))).toBe(true);
  });
});
