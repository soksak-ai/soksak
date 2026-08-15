import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(import.meta.dirname, "catalogDom.ts"), "utf8");

// R5 requires an alignment claim to be proven with numbers. If this command answers only the horizontal axis,
// a claim about the vertical sides cannot be proven, and the only path left is a person looking at the screen.
//
// Measured 2026-08-15: asked whether the panel had a right outline, ui.measure answered only borderTop and
// borderBottom. Someone familiar with that spot had to point it out with a screenshot, which is exactly the
// situation this command exists to remove.
describe("ui.measure — axis symmetry", () => {
  it("the border is answered on all four sides", () => {
    for (const side of ["Top", "Right", "Bottom", "Left"]) {
      expect(source, `border${side} is not answered`).toContain(`border${side}: cs.border${side}Width`);
    }
  });

  it("the padding is answered on all four sides too", () => {
    for (const side of ["Top", "Right", "Bottom", "Left"]) {
      expect(source, `padding${side} is not answered`).toContain(`padding${side}: cs.padding${side}`);
    }
  });

  it("the vertical dimension is not the only one answered", () => {
    // With height but no width, a claim about horizontal layout cannot be measured.
    expect(source).toContain("width: cs.width");
  });
});
