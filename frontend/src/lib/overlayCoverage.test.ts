import { describe, expect, it } from "vitest";
import { coversBox } from "./overlayCoverage";

const box = { left: 100, top: 100, right: 300, bottom: 200 };

describe("what an overlay covers", () => {
  it("covers a box an area overlaps", () => {
    expect(coversBox([{ left: 250, top: 150, right: 400, bottom: 250 }], box)).toBe(true);
  });

  it("covers nothing when no area reaches it", () => {
    expect(coversBox([{ left: 310, top: 100, right: 400, bottom: 200 }], box)).toBe(false);
  });

  // A modal names no area. It covers the window, and every surface steps aside for it.
  it("covers every box for an area that is not named", () => {
    expect(coversBox([null], box)).toBe(true);
  });

  it("covers nothing when no overlay is open", () => {
    expect(coversBox([], box)).toBe(false);
  });

  // Touching edges is not overlap: a menu that ends where a pane begins is not over that pane, and
  // parking it would swap a surface for a picture with nothing to show for it.
  it("does not count a shared edge as coverage", () => {
    expect(coversBox([{ left: 300, top: 100, right: 400, bottom: 200 }], box)).toBe(false);
    expect(coversBox([{ left: 0, top: 0, right: 100, bottom: 100 }], box)).toBe(false);
  });
});
