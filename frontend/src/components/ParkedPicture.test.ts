import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("ParkedPicture stacking contract", () => {
  // The picture stands in for a native surface the provider body would otherwise cover, and it
  // stands over the veil it draws for itself. The lighting plane exempts a cell that draws that
  // veil, so the picture has no plane to clear.
  //
  // The gate reads the relation, not a number.
  it("paints above the provider body and above the veil it draws for itself", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../App.css"), "utf8");
    const rule = css.match(/\.parked-picture\s*\{([^}]*)\}/)?.[1] ?? "";
    const veil = css.match(/\.parked-picture-veil\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(rule).toContain("position: absolute");
    expect(rule).toContain("pointer-events: none");
    expect(veil).toContain("position: absolute");
    expect(veil).toContain("pointer-events: none");

    const layerOf = (block: string) => Number(block.match(/z-index:\s*(\d+)/)?.[1] ?? NaN);
    expect(layerOf(veil)).not.toBeNaN();
    expect(layerOf(rule)).toBeGreaterThan(layerOf(veil));
  });
});
