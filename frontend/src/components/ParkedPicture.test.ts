import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("ParkedPicture stacking contract", () => {
  // The picture stands in for a native surface, which is composited above the document: above the
  // provider body it is drawn over, and above the focus lighting veil the veil never reached.
  // Drawn under that veil, a parked pane read 127 on white where the live one read 191, and every
  // unfocused pane darkened the moment an overlay opened (measured 2026-09-04).
  //
  // The gate reads the relation, not a number: the veil's own layer is the thing this has to clear.
  it("paints above the provider body and above the focus lighting veil", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../App.css"), "utf8");
    const rule = css.match(/\.parked-picture\s*\{([^}]*)\}/)?.[1] ?? "";
    const plane = css.match(/\.focus-lighting-plane\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(rule).toContain("position: absolute");
    expect(rule).toContain("pointer-events: none");

    const layerOf = (block: string) => Number(block.match(/z-index:\s*(\d+)/)?.[1] ?? NaN);
    expect(layerOf(plane)).not.toBeNaN();
    expect(layerOf(rule)).toBeGreaterThan(layerOf(plane));
  });
});
